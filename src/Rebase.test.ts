import { execFileSync } from "node:child_process"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { Git } from "./Git.ts"
import { run } from "./Rebase.ts"
import { RunnerEnv } from "./Runner.ts"

describe("run", () => {
  const dirs: Array<string> = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      Fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

  const commit = (cwd: string, file: string, content: string, message: string) => {
    Fs.writeFileSync(Path.join(cwd, file), content)
    git(cwd, "add", file)
    git(cwd, "commit", "-m", message)
  }

  const lines = (...overrides: ReadonlyArray<[number, string]>) => {
    const result = ["a", "b", "c", "d", "e", "f", "g"]
    for (const [index, line] of overrides) {
      result[index] = line
    }
    return result.join("\n") + "\n"
  }

  it("replays only the major branch's own commits after the minor branch is rewritten", async () => {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "rebase-test-"))
    dirs.push(root)
    const origin = Path.join(root, "origin.git")
    const seed = Path.join(root, "seed")
    const work = Path.join(root, "work")

    git(root, "init", "--bare", "-b", "main", origin)
    git(root, "init", "-b", "main", seed)
    git(seed, "config", "user.name", "test")
    git(seed, "config", "user.email", "test@example.com")
    git(seed, "remote", "add", "origin", origin)

    commit(seed, "file.txt", lines(), "initial")
    git(seed, "checkout", "-b", "next-minor")
    commit(seed, "file.txt", lines([3, "d1"]), "minor: first")
    commit(seed, "file.txt", lines([3, "d2"]), "minor: second")
    git(seed, "checkout", "-b", "next-major")
    commit(seed, "major.txt", "major\n", "major: own")
    git(seed, "push", "origin", "main", "next-minor", "next-major")

    // Changes the context of both minor patches, so rebasing minor rewrites them.
    git(seed, "checkout", "main")
    commit(seed, "file.txt", lines([1, "b1"]), "main: update")
    git(seed, "push", "origin", "main")

    git(root, "clone", origin, work)

    const TestGit = Layer.effect(
      Git,
      Git.pipe(Effect.map((git) => ({ ...git, open: () => git.open(work) }))),
    ).pipe(
      Layer.provide(
        Git.layer({
          userName: Config.succeed("test"),
          userEmail: Config.succeed("test@example.com"),
          simpleGit: Config.succeed({}),
        }),
      ),
    )
    const TestRunnerEnv = Layer.succeed(RunnerEnv, {
      repo: { default_branch: "main" },
    } as unknown as RunnerEnv["Service"])
    const provider = ConfigProvider.fromEnv({ env: {} }).pipe(
      ConfigProvider.constantCase,
      ConfigProvider.layer,
    )

    // Release branch sync never touches individual pull requests, so `run` must not require
    // `PullRequests`: providing only these layers fails to type check if that changes.
    await run.pipe(
      Effect.provide(Layer.mergeAll(TestGit, TestRunnerEnv, provider)),
      Effect.runPromise,
    )

    expect(git(origin, "merge-base", "--is-ancestor", "main", "next-minor")).toBe("")
    expect(git(origin, "rev-parse", "next-major^")).toBe(git(origin, "rev-parse", "next-minor"))
    expect(git(origin, "log", "-1", "--format=%s", "next-major")).toBe("major: own")
  }, 20_000)
})
