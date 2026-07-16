import * as Array from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import type * as AST from "mdast"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { PullRequests } from "./PullRequests.ts"
import { Github } from "./Github.ts"

export class Changesets extends Context.Service<Changesets>()("app/Changesets", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pulls = yield* PullRequests

    const current = (packages: ReadonlyArray<string>) =>
      pulls.currentFiles.pipe(
        Stream.filter(
          (_) =>
            _.status === "added" &&
            _.filename.startsWith(".changeset/") &&
            _.filename.endsWith(".md"),
        ),
        Stream.mapEffect((_) => fs.readFileString(_.filename)),
        Stream.flatMap((_) => Stream.fromIterable(parse(_))),
        packages.length > 0 ? Stream.filter(([pkg]) => packages.includes(pkg)) : identity,
      )

    const currentTypes = (packages: ReadonlyArray<string>) =>
      current(packages).pipe(
        Stream.filter((_) => _[1] === "minor" || _[1] === "major"),
        Stream.map(([, type]) => type),
        Stream.runCollect,
        Effect.map(Array.dedupe),
      )

    const currentMaxType = (packages: ReadonlyArray<string>) =>
      currentTypes(packages).pipe(
        Effect.map((types): Option.Option<ChangeType> => {
          if (types.includes("major")) {
            return Option.some("major")
          } else if (types.includes("minor")) {
            return Option.some("minor")
          } else if (types.includes("patch")) {
            return Option.some("patch")
          }
          return Option.none()
        }),
      )

    return { current, currentTypes, currentMaxType } as const
  }),
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make)

  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(PullRequests.layer),
    Layer.provide(Github.layer),
  )
}

//

const ChangeRegex = /"(.+?)":\s*(patch|minor|major)/g

type Change = [pkg: string, type: ChangeType]
type ChangeType = "patch" | "minor" | "major"

const parse = (content: string): Array<Change> => {
  const root = unified().use(remarkParse).parse(content)
  return Array.findFirst(root.children, (_): _ is AST.Heading => _.type === "heading").pipe(
    Option.flatMap((_) => Array.findFirst(_.children, (_): _ is AST.Text => _.type === "text")),
    Option.map((_) =>
      [..._.value.matchAll(ChangeRegex)].map(([, pkg, type]) => [pkg, type] as Change),
    ),
    Option.getOrElse(() => []),
  )
}
