import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Changesets } from "./Changesets.ts"
import * as Config from "./Config.ts"
import { Github } from "./Github.ts"
import { NoPullRequest, PullRequests } from "./PullRequests.ts"
import { RunnerEnv } from "./Runner.ts"

export const run = Effect.gen(function* () {
  const pulls = yield* PullRequests
  const pull = yield* pulls.current
  const prefix = yield* Config.prefix

  if (pull.head.ref.startsWith(`${prefix}-`)) {
    return yield* new NoPullRequest()
  }

  const changesets = yield* Changesets
  const packages = yield* Config.packages
  const changeTypeOption = yield* changesets
    .currentMaxType(packages)
    .pipe(Effect.map(Option.filter((_): _ is "major" | "minor" => _ !== "patch")))
  if (Option.isNone(changeTypeOption)) {
    return yield* Console.log("Not a minor or major change")
  }

  const changeType = changeTypeOption.value
  const targetBase = `${prefix}-${changeType}`
  const currentBase = pull.base.ref as string

  if (currentBase === targetBase) {
    return yield* Console.log("No update needed")
  }

  if (changeType === "major") {
    yield* ensureBranchFor("minor")
  }
  yield* ensureBranchFor(changeType)

  yield* pulls.setCurrentBase(targetBase)
  yield* pulls.addCurrentLabels([targetBase])
  yield* Console.log(`Updated base to ${targetBase}`)
})

const getBranch = Effect.fn(function* (branch: string) {
  const env = yield* RunnerEnv
  const github = yield* Github
  const getBranch = github.wrap((_) => _.repos.getBranch)
  return yield* getBranch({
    owner: env.repo.owner.login,
    repo: env.repo.name,
    branch,
  })
})

const getDefaultBranch = Effect.flatMap(Config.baseBranch, getBranch)

const ensureBranchFor = Effect.fn(function* (changeType: "major" | "minor") {
  const env = yield* RunnerEnv
  const github = yield* Github
  const prefix = yield* Config.prefix

  const baseBranch =
    changeType === "minor" ? yield* getDefaultBranch : yield* getBranch(`${prefix}-minor`)
  const sha = baseBranch.commit.sha
  const ref = `${prefix}-${changeType}`

  const createBranch = github.wrap((_) => _.git.createRef)
  const create = createBranch({
    owner: env.repo.owner.login,
    repo: env.repo.name,
    ref: `refs/heads/${ref}`,
    sha,
  })

  yield* getBranch(ref).pipe(
    Effect.catchIf(
      (e) => e.reason.status === 404,
      (_) => create,
    ),
  )
})
