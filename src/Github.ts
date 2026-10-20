import { getOctokit } from "@actions/github"
import type { OctokitResponse, RequestError } from "@octokit/types"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { inputSecret } from "./utils/config.ts"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

export class GithubError extends Data.TaggedError("GithubError")<{
  readonly cause: RequestError
}> {}

type GithubApi = ReturnType<typeof getOctokit>
type Endpoints = GithubApi["rest"]

export interface GithubService {
  readonly api: GithubApi
  readonly token: Redacted.Redacted<string>
  readonly request: <A>(f: (_: Endpoints) => Promise<A>) => Effect.Effect<A, GithubError>
  readonly wrap: <A, Args extends ReadonlyArray<unknown>>(
    f: (_: Endpoints) => (...args: Args) => Promise<OctokitResponse<A>>,
  ) => (...args: Args) => Effect.Effect<A, GithubError>
  readonly streamWith: <A, B>(
    f: (_: Endpoints, page: number) => Promise<OctokitResponse<A>>,
    g: (_: A) => ReadonlyArray<B>,
  ) => Stream.Stream<B, GithubError>
  readonly stream: <A>(
    f: (_: Endpoints, page: number) => Promise<OctokitResponse<ReadonlyArray<A>>>,
  ) => Stream.Stream<A, GithubError>
  readonly cli: (...args: ReadonlyArray<string>) => ChildProcess.StandardCommand
}

export class Github extends Context.Service<Github, GithubService>()("Github", {
  make: Effect.gen(function* () {
    const token = yield* inputSecret("github_token")
    const api = getOctokit(Redacted.value(token))

    const rest = api.rest
    const request = <A>(f: (_: Endpoints) => Promise<A>) =>
      Effect.tryPromise({
        try: () => f(rest),
        catch: (cause) => new GithubError({ cause: cause as RequestError }),
      }).pipe(
        Effect.retry({
          while: (err) =>
            err.cause.status === 403 || err.cause.status === 429 || err.cause.status >= 500,
          schedule: Schedule.max([
            Schedule.exponential("1 second"),
            Schedule.spaced("60 seconds"),
          ]).pipe(Schedule.upTo({ times: 10 })),
        }),
      )

    const wrap =
      <A, Args extends ReadonlyArray<unknown>>(
        f: (_: Endpoints) => (...args: Args) => Promise<OctokitResponse<A>>,
      ) =>
      (...args: Args) =>
        Effect.map(
          request((rest) => f(rest)(...args)),
          (_) => _.data,
        )

    const streamWith = <A, B>(
      f: (_: Endpoints, page: number) => Promise<OctokitResponse<A>>,
      g: (_: A) => ReadonlyArray<B>,
    ) =>
      Stream.paginate(1, (page) =>
        request((rest) => f(rest, page)).pipe(
          Effect.map((_) => [g(_.data), maybeNextPage(page, _.headers.link)]),
        ),
      )

    const stream = <A>(
      f: (_: Endpoints, page: number) => Promise<OctokitResponse<ReadonlyArray<A>>>,
    ) => streamWith(f, (_) => _)

    const cli = (...args: ReadonlyArray<string>) =>
      ChildProcess.make("gh", args, {
        shell: true,
        extendEnv: true,
        env: {
          GH_TOKEN: Redacted.value(token),
        },
      })

    return { api, token, request, wrap, stream, streamWith, cli } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const maybeNextPage = (page: number, linkHeader?: string) =>
  Option.fromNullishOr(linkHeader).pipe(
    Option.filter((_) => _.includes(`rel="next"`)),
    Option.as(page + 1),
  )
