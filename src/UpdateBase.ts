import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Changesets } from "./Changesets.ts"
import * as Config from "./Config.ts"
import { Github } from "./Github.ts"
import { NoPullRequest, PullRequests } from "./PullRequests.ts"
import { RunnerEnv } from "./Runner.ts"

export class UnsupportedReleaseType extends Data.TaggedError("UnsupportedReleaseType")<{
  readonly type: Config.ReleaseType
}> {
  get message() {
    return `No eligible branch is configured for '${this.type}' releases. Target a branch that supports this release type or change the changeset.`
  }
}

export const run = Effect.gen(function* () {
  const pulls = yield* PullRequests
  const pull = yield* pulls.current
  const branches = yield* Config.eligibleBranches

  if (branches.some((branch) => branch.name === pull.head.ref)) {
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
  const targetBranch = yield* Config.branchFor(branches, changeType).pipe(
    Effect.fromOption,
    Effect.mapError(() => new UnsupportedReleaseType({ type: changeType })),
  )
  const targetBase = targetBranch.name
  const currentBase = pull.base.ref

  if (currentBase === targetBase) {
    return yield* Console.log("No update needed")
  }

  const base = yield* Config.baseBranch
  let branchBase = base
  for (const branch of branches) {
    yield* ensureBranch(branch.name, branchBase)
    if (branch.name === targetBranch.name) {
      break
    }
    branchBase = branch.name
  }

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

const ensureBranch = Effect.fn(function* (ref: string, base: string) {
  const env = yield* RunnerEnv
  const github = yield* Github
  const baseBranch = yield* getBranch(base)
  const sha = baseBranch.commit.sha

  const createBranch = github.wrap((_) => _.git.createRef)
  const create = createBranch({
    owner: env.repo.owner.login,
    repo: env.repo.name,
    ref: `refs/heads/${ref}`,
    sha,
  })

  yield* getBranch(ref).pipe(
    Effect.catchIf(
      (e) => e.cause.status === 404,
      (_) => create,
    ),
  )
})
