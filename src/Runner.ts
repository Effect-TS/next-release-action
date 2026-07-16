import * as OS from "node:os"
import { context } from "@actions/github"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"

type GithubContext = typeof context
type Payload = GithubContext["payload"]

export interface RunnerEnvService {
  readonly tmpDir: string
  readonly mkTmpDir: (path: string) => Effect.Effect<string, PlatformError.PlatformError>
  readonly issue: Option.Option<GithubContext["issue"]>
  readonly repo: NonNullable<Payload["repository"]>
  readonly comment: Option.Option<NonNullable<Payload["comment"]>>
  readonly actor: string
  readonly pull: Option.Option<NonNullable<Payload["pull_request"]>>
  readonly ref: string
  readonly isOrigin: boolean
}

export class RunnerEnv extends Context.Service<RunnerEnv, RunnerEnvService>()("app/RunnerEnv", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const tmpDir = yield* Config.string("RUNNER_TEMP").pipe(Config.withDefault(OS.tmpdir()))

    const mkTmpDir = (p: string) => {
      const dir = path.join(tmpDir, p)
      return fs
        .remove(dir, { recursive: true })
        .pipe(Effect.ignore, Effect.andThen(fs.makeDirectory(dir)), Effect.as(dir))
    }

    const issue = Option.fromNullishOr(context.issue.number).pipe(Option.as(context.issue))
    const repo = context.payload.repository!
    const comment = Option.fromNullishOr(context.payload.comment)
    const pull = Option.fromNullishOr(context.payload.pull_request)
    const actor = context.actor

    const ref = yield* Config.nonEmptyString("GITHUB_HEAD_REF").pipe(
      Config.orElse(() => Config.nonEmptyString("GITHUB_REF_NAME")),
    )

    const isOrigin =
      Option.isNone(pull) || pull.value.head.repo.owner.login === pull.value.base.repo.owner.login

    return {
      tmpDir,
      mkTmpDir,
      issue,
      repo,
      comment,
      actor,
      pull,
      ref,
      isOrigin,
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
