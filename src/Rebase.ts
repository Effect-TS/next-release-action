import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
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

  const pulls = yield* PullRequests
  yield* fetchOrigin
  for (const branch of branches) {
    yield* pulls.listOpen(branch.name).pipe(
      Stream.filter((pull) => shouldAutoRebase(branches, pull)),
      Stream.runForEach((pull) => rebasePull(pull).pipe(Effect.catchCause(Effect.log))),
    )
  }
})

export class PullCheckoutError extends Data.TaggedError("PullCheckoutError")<{
  readonly number: number
}> {
  get message() {
    return `failed to check out #${this.number}`
  }
}

interface RebasePull {
  readonly number: number
  readonly base: { readonly ref: string }
  readonly head: {
    readonly ref: string
    readonly sha: string
    readonly repo: { readonly clone_url: string } | null
  }
}

export const shouldAutoRebase = (
  branches: ReadonlyArray<Config.ReleaseBranch>,
  pull: {
    readonly draft?: boolean | undefined
    readonly base: { readonly ref: string; readonly repo: { readonly full_name: string } }
    readonly head: {
      readonly ref: string
      readonly repo: { readonly full_name: string } | null
    }
  },
) =>
  pull.draft !== true &&
  branches.some((branch) => branch.name === pull.base.ref) &&
  // Release branch heads are rebased with their branch; same-named fork branches are not.
  !(
    pull.head.repo?.full_name === pull.base.repo.full_name &&
    branches.some((branch) => branch.name === pull.head.ref)
  )

// Expects origin to be fetched. Aborts a failed rebase so the checkout can be reused.
const rebasePull = Effect.fn(function* (pull: RebasePull) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const gh = yield* Github
  const git = yield* Git.pipe(Effect.flatMap((_) => _.open(".")))
  const headRepo = pull.head.repo
  if (headRepo === null) {
    return yield* Effect.log(`skipping #${pull.number}: head repository is missing`)
  }

  yield* Effect.log(`rebasing #${pull.number} on ${pull.base.ref}`)
  const command = gh.cli("pr", "checkout", "-b", "pr-branch", "--force", pull.number.toString())
  yield* spawner.exitCode(command).pipe(
    Effect.filterOrFail(
      (code) => code === 0,
      () => new PullCheckoutError({ number: pull.number }),
    ),
  )

  yield* git
    .run((_) =>
      _.rebase([`origin/${pull.base.ref}`]).push([
        headRepo.clone_url,
        `pr-branch:${pull.head.ref}`,
        `--force-with-lease=${pull.head.ref}:${pull.head.sha}`,
      ]),
    )
    .pipe(Effect.tapError(() => git.run((_) => _.rebase(["--abort"])).pipe(Effect.ignore)))
})

export const runCurrent = Effect.gen(function* () {
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

  yield* git.run((_) => _.fetch("origin"))
  yield* rebasePull(current.value)
})
