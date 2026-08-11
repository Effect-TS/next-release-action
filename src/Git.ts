import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SG from "simple-git"

export class GitError extends Data.TaggedError("GitError")<{
  readonly cause: SG.GitError
}> {
  get message() {
    return this.cause.message
  }
}

export interface GitConfig extends Partial<SG.SimpleGitOptions> {
  simpleGit?: Partial<SG.SimpleGitOptions>
  userName: string
  userEmail: string
}

export interface GitRepoService {
  readonly path: string
  readonly git: SG.SimpleGit
  readonly run: <A>(f: (git: SG.SimpleGit) => Promise<A>) => Effect.Effect<A, GitError>
}
export class GitRepo extends Context.Service<GitRepo, GitRepoService>()("app/GitRepo") {}

const make = ({ simpleGit: opts = {}, userName, userEmail }: GitConfig) => {
  const clone = (url: string, dir: string) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => SG.simpleGit(opts).clone(url, dir),
        catch: (cause) => new GitError({ cause: cause as SG.GitError }),
      })

      return yield* open(dir)
    })

  const open = (dir: string) =>
    Effect.gen(function* () {
      const git = SG.simpleGit(dir, opts)

      const run = <A>(f: (git: SG.SimpleGit) => Promise<A>) =>
        Effect.tryPromise({
          try: () => f(git),
          catch: (cause) => new GitError({ cause: cause as SG.GitError }),
        })

      yield* run((_) => _.addConfig("user.name", userName).addConfig("user.email", userEmail))

      return GitRepo.of({ git, run, path: dir })
    })

  return { clone, open } as const
}

export class Git extends Context.Service<Git, ReturnType<typeof make>>()("app/Git") {
  static readonly layer = (config: Config.Wrap<GitConfig>) =>
    Config.unwrap(config).pipe(Effect.map(make), Layer.effect(Git))
}
