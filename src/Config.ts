import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { input } from "./utils/config.ts"
import { RunnerEnv } from "./Runner.ts"

export const baseBranch = input("base_branch").pipe(
  Effect.catch(() => Effect.map(Effect.service(RunnerEnv), (_) => _.repo.default_branch as string)),
)

export const prefix = Config.withDefault(input("branch_prefix"), "next")

export const packages: Config.Config<ReadonlyArray<string>> = Config.schema(
  Config.Array(Schema.NonEmptyString),
  "packages",
).pipe(Config.nested("input"), Config.withDefault([]))
