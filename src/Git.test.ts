import type * as SG from "simple-git"
import { describe, expect, it } from "vite-plus/test"
import { GitError } from "./Git.ts"

describe("GitError", () => {
  it("preserves git failures as the error cause", () => {
    const cause = new Error("git failed") as SG.GitError
    const error = new GitError({ cause })

    expect(error.cause).toBe(cause)
    expect(error.message).toBe(cause.message)
  })
})
