import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vite-plus/test"
import { Github } from "./Github.ts"

describe("Github", () => {
  it("preserves request errors in GithubError", async () => {
    const reason = Object.assign(new Error("Not Found"), { status: 404 })
    const provider = ConfigProvider.fromEnv({
      env: { INPUT_GITHUB_TOKEN: "test-token" },
    }).pipe(ConfigProvider.constantCase, ConfigProvider.layer)

    const error = await Effect.gen(function* () {
      const github = yield* Github
      return yield* github.request(() => Promise.reject(reason)).pipe(Effect.flip)
    }).pipe(Effect.provide(Github.layer), Effect.provide(provider), Effect.runPromise)

    expect(error.reason).toBe(reason)
  })
})
