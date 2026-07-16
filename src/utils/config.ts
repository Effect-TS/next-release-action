import * as Config from "effect/Config"
import * as Redacted from "effect/Redacted"

export const input = (name: string) => Config.nonEmptyString(name).pipe(Config.nested("input"))

export const inputSecret = (name: string) =>
  Config.nonEmptyString(name).pipe(Config.nested("input"), Config.map(Redacted.make))
