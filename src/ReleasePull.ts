import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as Order from "effect/Order"
import * as Stream from "effect/Stream"
import * as Config from "./Config.ts"
import { Git } from "./Git.ts"
import { Github } from "./Github.ts"
import { PullRequests } from "./PullRequests.ts"
import { RunnerEnv } from "./Runner.ts"

export const run = Effect.gen(function* () {
  const env = yield* RunnerEnv
  const branches = yield* Config.eligibleBranches
  const branch = branches.find((branch) => branch.name === env.ref)

  if (branch === undefined) {
    return
  }

  const head = branch.name
  const baseBranch = yield* Config.baseBranch
  const base = Config.baseFor(branches, branch, baseBranch)

  const git = yield* Git.pipe(Effect.flatMap((_) => _.open(".")))
  const headSha = yield* git.run((_) => _.fetch("origin").revparse(`origin/${head}`))
  const baseSha = yield* git.run((_) => _.revparse(`origin/${base}`))
  if (headSha === baseSha) return

  const pulls = yield* PullRequests
  const body = yield* pullBody(base, head)
  yield* pulls.upsert({
    head,
    base,
    title: `Release queue: ${branch.type}`,
    body,
  })
})

const pullBody = (base: string, head: string) =>
  Effect.gen(function* () {
    const related = yield* diffPulls(base, head).pipe(
      Stream.runCollect,
      Effect.map((pulls) =>
        pipe(
          pulls,
          Array.dedupeWith((a, b) => a.number === b.number),
          Array.sort(Order.Struct({ number: Order.Number })),
        ),
      ),
    )

    const listItems = related.map((pull) => `- #${pull.number}`).join("\n")

    return `Contains the following pull requests:\n\n${listItems}`
  })

const diffPulls = (base: string, head: string) =>
  Effect.gen(function* () {
    const pulls = yield* PullRequests
    const currentNumber = yield* pulls.current.pipe(
      Effect.map((_) => _.number),
      Effect.orElseSucceed(() => 0),
    )
    return diffCommits(base, head).pipe(
      Stream.mapEffect((commit) => pulls.forCommit(commit.sha)),
      Stream.flattenIterable,
      Stream.filter((_) => _.number !== currentNumber),
    )
  }).pipe(Stream.unwrap)

const diffCommits = (base: string, head: string) =>
  Effect.gen(function* () {
    const env = yield* RunnerEnv
    const github = yield* Github
    return github.streamWith(
      (_, page) =>
        _.repos.compareCommits({
          owner: env.repo.owner.login,
          repo: env.repo.name,
          base: base,
          head,
          page,
        }),
      (_) => _.commits,
    )
  }).pipe(Stream.unwrap)
