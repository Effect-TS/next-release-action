import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Comments } from "./Comments.ts"
import * as Config from "./Config.ts"
import { Git } from "./Git.ts"
import { Github } from "./Github.ts"
import { Permissions } from "./Permissions.ts"
import { PullRequests } from "./PullRequests.ts"

export const runComment = Effect.gen(function* () {
  const comments = yield* Comments
  const perms = yield* Permissions

  yield* perms.whenCollaboratorOrAuthor(
    Effect.gen(function* () {
      yield* comments.reactCurrent("eyes")
      yield* runCurrent
      yield* comments.reactCurrent("rocket")
    }).pipe(Effect.tapCause(() => comments.reactCurrent("-1"))),
  )
})

export const run = Effect.gen(function* () {
  const git = yield* Git.pipe(Effect.flatMap((_) => _.open(".")))
  const branches = yield* Config.eligibleBranches
  const base = yield* Config.baseBranch
  const fetchOrigin = git.run((_) => _.fetch("origin"))

  const rebase = (branch: string, branchBase: string, reset: boolean) =>
    Effect.gen(function* () {
      yield* fetchOrigin
      yield* Effect.log(`rebasing ${branch} on ${branchBase}`)
      yield* git
        .run((_) => {
          const checkout = _.checkout(branch)
          const current = reset ? checkout.reset(["--hard", `origin/${branch}`]) : checkout
          return current.rebase([`origin/${branchBase}`]).push(["--force"])
        })
        .pipe(
          Effect.tapError((_) => git.run((_) => _.rebase(["--abort"]))),
          Effect.catchCause(Effect.log),
        )
    })

  for (let index = branches.length - 1; index > 0; index--) {
    const branch = branches[index]
    const branchBase = branches[index - 1]
    if (branch !== undefined && branchBase !== undefined) {
      yield* rebase(branch.name, branchBase.name, false)
    }
  }

  for (let index = 0; index < branches.length; index++) {
    const branch = branches[index]
    if (branch !== undefined) {
      yield* rebase(branch.name, Config.baseFor(branches, branch, base), index > 0)
    }
  }
})

export const runCurrent = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const gh = yield* Github
  const git = yield* Git.pipe(Effect.flatMap((_) => _.open(".")))
  const branches = yield* Config.eligibleBranches
  const pulls = yield* PullRequests

  const current = yield* pulls.current.pipe(
    Effect.filterOrFail((pull) => branches.some((branch) => branch.name === pull.base.ref)),
    Effect.option,
  )
  if (Option.isNone(current)) {
    return
  }

  const pull = current.value
  yield* git.run((_) => _.fetch("origin").checkout(pull.base.ref))

  yield* Effect.log(`rebasing #${pull.number} on ${pull.base.ref}`)
  const command = gh.cli("pr", "checkout", "-b", "pr-branch", "--force", pull.number.toString())
  yield* spawner.exitCode(command)

  yield* git.run((_) =>
    _.rebase([pull.base.ref]).push([
      pull.head.repo!.clone_url,
      `pr-branch:${pull.head.ref}`,
      "--force",
    ]),
  )
})
