import { defineConfig } from "vite-plus"

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    deps: {
      alwaysBundle: [/.*/],
      onlyBundle: false,
    },
    dts: {
      tsgo: true,
    },
    exports: {
      inlinedDependencies: false,
    },
    minify: true,
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["dist/**"],
    semi: false,
  },
})
