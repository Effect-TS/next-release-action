import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionConfig from "./Config.ts"
import { Changesets } from "./Changesets.ts"
import { Comments } from "./Comments.ts"
import { Git } from "./Git.ts"
import { Github } from "./Github.ts"
import { Permissions } from "./Permissions.ts"
import { PullRequests } from "./PullRequests.ts"
import * as Rebase from "./Rebase.ts"
import * as ReleasePull from "./ReleasePull.ts"
import { RunnerEnv } from "./Runner.ts"
import * as UpdateBase from "./UpdateBase.ts"
import { input } from "./utils/config.ts"

const githubActor = Config.nonEmptyString("github_actor")

const githubActorEmail = githubActor.pipe(Config.map((_) => `${_}@users.noreply.github.com`))

const GitLayer = Git.layer({
  userName: input("git_user").pipe(Config.orElse(() => githubActor)),
  userEmail: input("git_email").pipe(Config.orElse(() => githubActorEmail)),
  simpleGit: Config.succeed({}),
})

const ConfigProviderLayer = ConfigProvider.fromEnv().pipe(
  ConfigProvider.constantCase,
  ConfigProvider.layer,
)

const MainLayer = Layer.mergeAll(
  Changesets.layer,
  Comments.layer,
  Permissions.layer,
  PullRequests.layer,
  RunnerEnv.layer,
  Github.layer,
  GitLayer,
).pipe(Layer.provide(ConfigProviderLayer), Layer.provideMerge(NodeServices.layer))

const main = Effect.gen(function* () {
  const gh = yield* Github
  const env = yield* RunnerEnv
  const baseBranch = yield* ActionConfig.baseBranch
  const prefix = yield* ActionConfig.prefix
  const eligibleBranches = [`${prefix}-major`, `${prefix}-minor`]
  const currentUser = (yield* gh.request((_) => _.users.getAuthenticated())).data.login

  yield* Effect.log("Running").pipe(
    Effect.annotateLogs({
      baseBranch,
      ref: env.ref,
      actor: env.actor,
      currentUser,
      isPR: Option.isSome(env.pull),
      isComment: Option.isSome(env.comment),
      eligibleBranches,
      isOrigin: env.isOrigin,
    }),
  )

  if (env.comment._tag === "Some" && env.comment.value.body.startsWith("/rebase")) {
    yield* Rebase.runComment
  } else if (eligibleBranches.includes(env.ref) && env.isOrigin) {
    if (env.actor !== currentUser) {
      yield* Rebase.run
    }
    yield* ReleasePull.run
  } else if (Option.isSome(env.pull)) {
    yield* UpdateBase.run.pipe(
      Effect.catchTags({
        NoPullRequest: () => Console.log("No pull request found"),
      }),
    )
  } else if (env.ref === baseBranch) {
    yield* Rebase.run
  }
}).pipe(Effect.provide(MainLayer))

NodeRuntime.runMain(main)
