import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { describe, expect, it } from "vite-plus/test"
import { baseFor, branchFor, eligibleBranches, parseEligibleBranches } from "./Config.ts"

describe("eligible branches", () => {
  it("preserves the default minor-to-major release hierarchy", async () => {
    const branches = await Effect.runPromise(parseEligibleBranches(["next-major", "next-minor"]))

    expect(branches).toEqual([
      { name: "next-minor", type: "minor" },
      { name: "next-major", type: "major" },
    ])
    const minor = Option.getOrThrow(branchFor(branches, "minor"))
    const major = Option.getOrThrow(branchFor(branches, "major"))
    expect(baseFor(branches, minor, "main")).toBe("main")
    expect(baseFor(branches, major, "main")).toBe("next-minor")
  })

  it("supports a namespaced minor-only release queue", async () => {
    const provider = ConfigProvider.fromEnv({
      env: { INPUT_ELIGIBLE_BRANCHES: "v3/next-minor" },
    }).pipe(ConfigProvider.constantCase, ConfigProvider.layer)
    const branches = await Effect.runPromise(eligibleBranches.pipe(Effect.provide(provider)))

    expect(branches).toEqual([{ name: "v3/next-minor", type: "minor" }])
    const minor = Option.getOrThrow(branchFor(branches, "minor"))
    expect(baseFor(branches, minor, "v3")).toBe("v3")
    expect(Option.isNone(branchFor(branches, "major"))).toBe(true)
  })

  it("rejects branches without a release type suffix", async () => {
    await expect(Effect.runPromise(parseEligibleBranches(["next"]))).rejects.toThrow(
      "branch 'next' must end with '-minor' or '-major'",
    )
  })

  it("rejects duplicate release types", async () => {
    await expect(
      Effect.runPromise(parseEligibleBranches(["next-minor", "v3/next-minor"])),
    ).rejects.toThrow("only one 'minor' branch may be configured")
  })
})
