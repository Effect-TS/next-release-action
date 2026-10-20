import { execFileSync } from "node:child_process"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { afterEach, describe, expect, it } from "vite-plus/test"
import type { ReleaseBranch } from "./Config.ts"
import { Git } from "./Git.ts"
import { Github } from "./Github.ts"
import { PullRequests } from "./PullRequests.ts"
import { run, shouldAutoRebase } from "./Rebase.ts"
import { RunnerEnv } from "./Runner.ts"

const branches: ReadonlyArray<ReleaseBranch> = [
  { name: "v4/next-minor", type: "minor" },
  { name: "v4/next-major", type: "major" },
]

const upstream = { full_name: "Effect-TS/effect" }
const fork = { full_name: "contributor/effect" }

const pull = (base: string, head: string, draft = false, headRepo = upstream) => ({
  draft,
  base: { ref: base, repo: upstream },
  head: { ref: head, repo: headRepo },
})

describe("shouldAutoRebase", () => {
  it("selects open non-draft feature PRs targeting a release branch", () => {
    expect(shouldAutoRebase(branches, pull("v4/next-minor", "feature-a"))).toBe(true)
    expect(shouldAutoRebase(branches, pull("v4/next-major", "feature-b"))).toBe(true)

    expect(shouldAutoRebase(branches, pull("v4/next-minor", "feature-c", true))).toBe(false)
    expect(shouldAutoRebase(branches, pull("main", "feature-d"))).toBe(false)
    // The "Release queue: major" PR is already rebased with its release branch.
    expect(shouldAutoRebase(branches, pull("v4/next-minor", "v4/next-major"))).toBe(false)
    // A fork branch that shares a release branch name is an ordinary contribution.
    expect(shouldAutoRebase(branches, pull("v4/next-minor", "v4/next-major", false, fork))).toBe(
      true,
    )
  })
})

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
    const TestPullRequests = Layer.succeed(PullRequests, {
      listOpen: () => Stream.empty,
    } as unknown as PullRequests["Service"])
    const TestRunnerEnv = Layer.succeed(RunnerEnv, {
      repo: { default_branch: "main" },
    } as unknown as RunnerEnv["Service"])
    const provider = ConfigProvider.fromEnv({
      env: { INPUT_GITHUB_TOKEN: "test-token" },
    }).pipe(ConfigProvider.constantCase, ConfigProvider.layer)

    await run.pipe(
      Effect.provide(Layer.mergeAll(TestGit, TestPullRequests, TestRunnerEnv, Github.layer)),
      Effect.provide(Layer.merge(provider, NodeServices.layer)),
      Effect.runPromise,
    )

    expect(git(origin, "merge-base", "--is-ancestor", "main", "next-minor")).toBe("")
    expect(git(origin, "rev-parse", "next-major^")).toBe(git(origin, "rev-parse", "next-minor"))
    expect(git(origin, "log", "-1", "--format=%s", "next-major")).toBe("major: own")
  }, 20_000)
})
