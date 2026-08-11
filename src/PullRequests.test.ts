import { getOctokit } from "@actions/github"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { describe, expect, it } from "vite-plus/test"
import { Github, GithubError, type GithubService } from "./Github.ts"
import { NoPullRequest, PullRequests } from "./PullRequests.ts"
import { RunnerEnv, type RunnerEnvService } from "./Runner.ts"

describe("PullRequests", () => {
  it("preserves the source failure when the current pull request cannot be loaded", async () => {
    const cause = new GithubError({ cause: "request failed" })
    const github: GithubService = {
      api: getOctokit("test-token"),
      token: Redacted.make("test-token"),
      request: () => Effect.fail(cause),
      wrap: () => () => Effect.fail(cause),
      streamWith: () => Stream.fail(cause),
      stream: () => Stream.fail(cause),
      cli: (...args) => ChildProcess.make("gh", args),
    }
    const runner: RunnerEnvService = {
      tmpDir: "/tmp",
      mkTmpDir: Effect.succeed,
      issue: Option.some({ owner: "owner", repo: "repo", number: 1 }),
      repo: {
        default_branch: "main",
        full_name: "owner/repo",
        name: "repo",
        owner: { login: "owner" },
      } as unknown as RunnerEnvService["repo"],
      comment: Option.none(),
      actor: "actor",
      pull: Option.none(),
      ref: "feature",
      isOrigin: true,
    }
    const dependencies = Layer.merge(
      Layer.succeed(Github, github),
      Layer.succeed(RunnerEnv, runner),
    )

    const error = await Effect.gen(function* () {
      const pulls = yield* PullRequests
      return yield* pulls.current.pipe(Effect.flip)
    }).pipe(
      Effect.provide(PullRequests.layerNoDeps.pipe(Layer.provide(dependencies))),
      Effect.runPromise,
    )

    expect(error).toBeInstanceOf(NoPullRequest)
    expect(error.cause).toBe(cause)
  })
})
