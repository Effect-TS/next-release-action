import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { input } from "./utils/config.ts"
import { RunnerEnv } from "./Runner.ts"

export const baseBranch = input("base_branch").pipe(
  Effect.catch(() => Effect.map(Effect.service(RunnerEnv), (_) => _.repo.default_branch as string)),
)

export const prefix = Config.withDefault(input("branch_prefix"), "next")

export type ReleaseType = "minor" | "major"

export interface ReleaseBranch {
  readonly name: string
  readonly type: ReleaseType
}

export class InvalidEligibleBranches extends Data.TaggedError("InvalidEligibleBranches")<{
  readonly reason: string
}> {
  get message() {
    return `Invalid eligible_branches input: ${this.reason}`
  }
}

const configuredEligibleBranches = Config.option(
  Config.schema(Config.Array(Schema.NonEmptyString), "eligible_branches").pipe(
    Config.nested("input"),
  ),
)

export const parseEligibleBranches = Effect.fn(function* (names: ReadonlyArray<string>) {
  const branches = new Map<ReleaseType, ReleaseBranch>()

  for (const name of names) {
    const type: ReleaseType | undefined = name.endsWith("-minor")
      ? "minor"
      : name.endsWith("-major")
        ? "major"
        : undefined

    if (type === undefined) {
      return yield* new InvalidEligibleBranches({
        reason: `branch '${name}' must end with '-minor' or '-major'`,
      })
    }
    if (branches.has(type)) {
      return yield* new InvalidEligibleBranches({
        reason: `only one '${type}' branch may be configured`,
      })
    }
    branches.set(type, { name, type })
  }

  if (branches.size === 0) {
    return yield* new InvalidEligibleBranches({ reason: "at least one branch is required" })
  }

  return (["minor", "major"] as const).flatMap((type) => {
    const branch = branches.get(type)
    return branch === undefined ? [] : [branch]
  })
})

export const eligibleBranches = Effect.gen(function* () {
  const configured = yield* configuredEligibleBranches
  const names = Option.isSome(configured)
    ? configured.value
    : yield* prefix.pipe(Effect.map((prefix) => [`${prefix}-minor`, `${prefix}-major`]))
  return yield* parseEligibleBranches(names)
})

export const branchFor = (branches: ReadonlyArray<ReleaseBranch>, type: ReleaseType) =>
  Option.fromNullishOr(branches.find((branch) => branch.type === type))

export const baseFor = (
  branches: ReadonlyArray<ReleaseBranch>,
  branch: ReleaseBranch,
  base: string,
) => {
  const index = branches.findIndex((candidate) => candidate.name === branch.name)
  return index <= 0 ? base : (branches[index - 1]?.name ?? base)
}

export const packages: Config.Config<ReadonlyArray<string>> = Config.schema(
  Config.Array(Schema.NonEmptyString),
  "packages",
).pipe(Config.nested("input"), Config.withDefault([]))
