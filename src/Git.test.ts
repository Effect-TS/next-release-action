import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import { simpleGit } from "simple-git"
import { describe, expect, it } from "vite-plus/test"
import { Git } from "./Git.ts"

describe("Git", () => {
  it("preserves failures from GitRepo.run as the error cause", async () => {
    const directory = await mkdtemp(join(tmpdir(), "next-release-action-git-"))
    await simpleGit(directory).init()

    try {
      const error = await Effect.gen(function* () {
        const git = yield* Git
        const repo = yield* git.open(directory)
        return yield* repo.run(() => Promise.reject("git failed")).pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          Git.layer({
            userName: Config.succeed("Test"),
            userEmail: Config.succeed("test@example.com"),
          }),
        ),
        Effect.runPromise,
      )

      expect(error.cause).toBe("git failed")
      expect(error.message).toBe("git failed")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
