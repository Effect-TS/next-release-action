import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Github } from "./Github.ts"
import { RunnerEnv } from "./Runner.ts"

export class Comments extends Context.Service<Comments>()("app/Comments", {
  make: Effect.gen(function* () {
    const env = yield* RunnerEnv
    const github = yield* Github

    const react = github.wrap((_) => _.reactions.createForIssueComment)
    const reactCurrent = (
      content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes",
    ) =>
      Effect.fromOption(env.comment).pipe(
        Effect.andThen((comment) =>
          react({
            owner: env.repo.owner.login,
            repo: env.repo.name,
            comment_id: comment.id,
            content,
          }),
        ),
      )

    return { react, reactCurrent } as const
  }),
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make)

  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(Github.layer),
    Layer.provide(RunnerEnv.layer),
  )
}
