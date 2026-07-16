import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Github } from "./Github.ts"
import { RunnerEnv } from "./Runner.ts"

export class Permissions extends Context.Service<Permissions>()("app/Permissions", {
  make: Effect.gen(function* () {
    const env = yield* RunnerEnv
    const github = yield* Github

    const check = github.wrap((_) => _.repos.checkCollaborator)
    const actorCheck = check({
      owner: env.repo.owner.login,
      repo: env.repo.name,
      username: env.actor,
    }).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    )

    const isPullAuthor = env.pull.pipe(
      Option.map((pull) => pull.user.login === env.actor),
      Option.getOrElse(() => false),
    )

    const whenCollaborator = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.when(effect, actorCheck)

    const whenCollaboratorOrAuthor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.when(effect, isPullAuthor ? Effect.succeed(true) : actorCheck)

    return { whenCollaborator, whenCollaboratorOrAuthor } as const
  }),
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make)

  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(Github.layer),
    Layer.provide(RunnerEnv.layer),
  )
}
