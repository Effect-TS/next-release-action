import { describe, expect, it } from "vite-plus/test"
import type { ReleaseBranch } from "./Config.ts"
import { shouldAutoRebase } from "./Rebase.ts"

const branches: ReadonlyArray<ReleaseBranch> = [
  { name: "v4/next-minor", type: "minor" },
  { name: "v4/next-major", type: "major" },
]

const pull = (base: string, head: string, draft = false) => ({
  draft,
  base: { ref: base },
  head: { ref: head },
})

describe("shouldAutoRebase", () => {
  it("selects open non-draft feature PRs targeting a release branch", () => {
    expect(shouldAutoRebase(branches, pull("v4/next-minor", "feature-a"))).toBe(true)
    expect(shouldAutoRebase(branches, pull("v4/next-major", "feature-b"))).toBe(true)

    expect(shouldAutoRebase(branches, pull("v4/next-minor", "feature-c", true))).toBe(false)
    expect(shouldAutoRebase(branches, pull("main", "feature-d"))).toBe(false)
    // The "Release queue: major" PR is already rebased with its release branch.
    expect(shouldAutoRebase(branches, pull("v4/next-minor", "v4/next-major"))).toBe(false)
  })
})
