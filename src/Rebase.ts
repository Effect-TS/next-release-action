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
  const prefix = yield* Config.prefix
  const base = yield* Config.baseBranch
  const fetchOrigin = git.run((_) => _.fetch("origin"))

  yield* fetchOrigin

  yield* Effect.log(`rebasing ${prefix}-major on ${prefix}-minor`)
  yield* git
    .run((_) =>
      _.checkout(`${prefix}-major`)
        .rebase([`origin/${prefix}-minor`])
        .push(["--force"]),
    )
    .pipe(
      Effect.tapError((_) => git.run((_) => _.rebase(["--abort"]))),
      Effect.catchCause(Effect.log),
    )

  yield* fetchOrigin

  yield* Effect.log(`rebasing ${prefix}-minor on ${base}`)
  yield* git
    .run((_) =>
      _.checkout(`${prefix}-minor`)
        .rebase([`origin/${base}`])
        .push(["--force"]),
    )
    .pipe(
      Effect.tapError((_) => git.run((_) => _.rebase(["--abort"]))),
      Effect.catchCause(Effect.log),
    )

  yield* fetchOrigin

  yield* Effect.log(`rebasing ${prefix}-major on ${prefix}-minor`)
  yield* git
    .run((_) =>
      _.checkout(`${prefix}-major`)
        .reset(["--hard", `origin/${prefix}-major`])
        .rebase([`origin/${prefix}-minor`])
        .push(["--force"]),
    )
    .pipe(
      Effect.tapError((_) => git.run((_) => _.rebase(["--abort"]))),
      Effect.catchCause(Effect.log),
    )
})

export const runCurrent = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const gh = yield* Github
  const git = yield* Git.pipe(Effect.flatMap((_) => _.open(".")))
  const prefix = yield* Config.prefix
  const pulls = yield* PullRequests

  const current = yield* pulls.current.pipe(
    Effect.filterOrFail(
      (pull) => pull.base.ref === `${prefix}-major` || pull.base.ref === `${prefix}-minor`,
    ),
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
