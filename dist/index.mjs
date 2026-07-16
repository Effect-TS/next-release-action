import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Redacted from "effect/Redacted"
import * as OS from "node:os"
import { context, getOctokit } from "@actions/github"
import * as Context from "effect/Context"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Array from "effect/Array"
import { identity, pipe } from "effect/Function"
import * as Stream from "effect/Stream"
import remarkParse from "remark-parse"
import { unified } from "unified"
import * as Data from "effect/Data"
import * as Schedule from "effect/Schedule"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as SG from "simple-git"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as Order from "effect/Order"
//#region src/utils/config.ts
const input = (name) => Config.nonEmptyString(name).pipe(Config.nested("input"))
const inputSecret = (name) =>
  Config.nonEmptyString(name).pipe(Config.nested("input"), Config.map(Redacted.make))
//#endregion
//#region src/Runner.ts
var RunnerEnv = class extends Context.Service()("app/RunnerEnv", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const tmpDir = yield* Config.string("RUNNER_TEMP").pipe(Config.withDefault(OS.tmpdir()))
    const mkTmpDir = (p) => {
      const dir = path.join(tmpDir, p)
      return fs
        .remove(dir, { recursive: true })
        .pipe(Effect.ignore, Effect.andThen(fs.makeDirectory(dir)), Effect.as(dir))
    }
    const issue = Option.fromNullishOr(context.issue.number).pipe(Option.as(context.issue))
    const repo = context.payload.repository
    const comment = Option.fromNullishOr(context.payload.comment)
    const pull = Option.fromNullishOr(context.payload.pull_request)
    return {
      tmpDir,
      mkTmpDir,
      issue,
      repo,
      comment,
      actor: context.actor,
      pull,
      ref: yield* Config.nonEmptyString("GITHUB_HEAD_REF").pipe(
        Config.orElse(() => Config.nonEmptyString("GITHUB_REF_NAME")),
      ),
      isOrigin:
        Option.isNone(pull) ||
        pull.value.head.repo.owner.login === pull.value.base.repo.owner.login,
    }
  }),
}) {
  static layer = Layer.effect(this, this.make)
}
//#endregion
//#region src/Config.ts
const baseBranch = input("base_branch").pipe(
  Effect.catch(() => Effect.map(Effect.service(RunnerEnv), (_) => _.repo.default_branch)),
)
const prefix = Config.withDefault(input("branch_prefix"), "next")
const packages = Config.schema(Config.Array(Schema.NonEmptyString), "packages").pipe(
  Config.nested("input"),
  Config.withDefault([]),
)
//#endregion
//#region src/Github.ts
var GithubError = class extends Data.TaggedError("GithubError") {}
var Github = class extends Context.Service()("Github", {
  make: Effect.gen(function* () {
    const token = yield* inputSecret("github_token")
    const api = getOctokit(Redacted.value(token))
    const rest = api.rest
    const request = (f) =>
      Effect.tryPromise({
        try: () => f(rest),
        catch: (reason) => new GithubError(reason),
      }).pipe(
        Effect.retry({
          while: (err) =>
            err.reason.status === 403 || err.reason.status === 429 || err.reason.status >= 500,
          schedule: Schedule.max([
            Schedule.exponential("1 second"),
            Schedule.spaced("60 seconds"),
          ]).pipe(Schedule.upTo({ times: 10 })),
        }),
      )
    const wrap =
      (f) =>
      (...args) =>
        Effect.map(
          request((rest) => f(rest)(...args)),
          (_) => _.data,
        )
    const streamWith = (f, g) =>
      Stream.paginate(0, (page) =>
        request((rest) => f(rest, page)).pipe(
          Effect.map((_) => [g(_.data), maybeNextPage(page, _.headers.link)]),
        ),
      )
    const stream = (f) => streamWith(f, (_) => _)
    const cli = (...args) =>
      ChildProcess.make("gh", args, {
        shell: true,
        env: { GH_TOKEN: Redacted.value(token) },
      })
    return {
      api,
      token,
      request,
      wrap,
      stream,
      streamWith,
      cli,
    }
  }),
}) {
  static layer = Layer.effect(this, this.make)
}
const maybeNextPage = (page, linkHeader) =>
  Option.fromNullishOr(linkHeader).pipe(
    Option.filter((_) => _.includes(`rel="next"`)),
    Option.as(page + 1),
  )
//#endregion
//#region src/PullRequests.ts
var NoPullRequest = class extends Data.TaggedError("NoPullRequest") {}
var PullRequests = class extends Context.Service()("app/PullRequests", {
  make: Effect.gen(function* () {
    const env = yield* RunnerEnv
    const github = yield* Github
    const get = github.wrap((_) => _.pulls.get)
    const find = (options) =>
      github
        .streamWith(
          (_, page) =>
            _.search.issuesAndPullRequests({
              page,
              q: [
                `repo:${env.repo.full_name}`,
                `base:${options.base}`,
                ...(options.head ? [`head:${options.head}`] : []),
                `state:open`,
                `is:pr`,
              ].join("+"),
            }),
          (_) => _.items,
        )
        .pipe(
          Stream.mapEffect((issue) =>
            get({
              owner: env.repo.owner.login,
              repo: env.repo.name,
              pull_number: issue.number,
            }),
          ),
        )
    const findFirst = (options) =>
      find(options).pipe(Stream.runHead, Effect.flatMap(Effect.fromOption))
    const create = github.wrap((_) => _.pulls.create)
    const update_ = github.wrap((_) => _.pulls.update)
    const update = (options) =>
      update_({
        ...options,
        owner: env.repo.owner.login,
        repo: env.repo.name,
      })
    const upsert = (options) =>
      Effect.matchEffect(findFirst(options), {
        onFailure: () =>
          create({
            owner: env.repo.owner.login,
            repo: env.repo.name,
            title: options.title,
            body: options.body,
            head: options.head,
            base: options.base,
          }),
        onSuccess: (pull) =>
          update({
            pull_number: pull.number,
            title: options.title,
            body: options.body,
            head: options.head,
            base: options.base,
          }),
      })
    const getPull = github.wrap((_) => _.pulls.get)
    const current = yield* Effect.fromOption(env.issue).pipe(
      Effect.flatMap((issue) =>
        getPull({
          owner: env.repo.owner.login,
          repo: env.repo.name,
          pull_number: issue.number,
        }),
      ),
      Effect.mapError(() => new NoPullRequest()),
      Effect.cached,
    )
    const files = (options) =>
      github.stream((_, page) =>
        _.pulls.listFiles({
          ...options,
          page,
        }),
      )
    const currentFiles = current.pipe(
      Effect.map((issue) =>
        files({
          owner: env.repo.owner.login,
          repo: env.repo.name,
          pull_number: issue.number,
        }),
      ),
      Stream.unwrap,
    )
    const setCurrentBase = (base) =>
      current.pipe(
        Effect.andThen((pull) =>
          update({
            pull_number: pull.number,
            base,
          }),
        ),
      )
    const addLabels = github.wrap((_) => _.issues.addLabels)
    const addCurrentLabels = (labels) =>
      Effect.andThen(current, (pull) =>
        addLabels({
          owner: env.repo.owner.login,
          repo: env.repo.name,
          issue_number: pull.number,
          labels,
        }),
      )
    const comment = github.wrap((_) => _.issues.createComment)
    const currentComment = (body) =>
      Effect.flatMap(current, (pull) =>
        comment({
          owner: env.repo.owner.login,
          repo: env.repo.name,
          issue_number: pull.number,
          body,
        }),
      )
    const getCommit = github.wrap((_) => _.repos.getCommit)
    const forCommit = (sha) =>
      getCommit({
        owner: env.repo.owner.login,
        repo: env.repo.name,
        ref: sha,
      }).pipe(
        Effect.flatMap((commit) =>
          Effect.partition(
            commit.commit.message.matchAll(/#(\d+)/g),
            ([, number]) =>
              getPull({
                owner: env.repo.owner.login,
                repo: env.repo.name,
                pull_number: Number(number),
              }),
            { concurrency: 3 },
          ),
        ),
        Effect.map(([, pulls]) => pulls),
      )
    const isOrigin = (pull) => pull.head.repo?.owner.login === env.repo.owner.login
    return {
      find,
      findFirst,
      upsert,
      update,
      current,
      files,
      currentFiles,
      setCurrentBase,
      addCurrentLabels,
      currentComment,
      forCommit,
      isOrigin,
    }
  }),
}) {
  static layerNoDeps = Layer.effect(this, this.make)
  static layer = this.layerNoDeps.pipe(Layer.provide(Github.layer), Layer.provide(RunnerEnv.layer))
}
//#endregion
//#region src/Changesets.ts
var Changesets = class extends Context.Service()("app/Changesets", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pulls = yield* PullRequests
    const current = (packages) =>
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
    const currentTypes = (packages) =>
      current(packages).pipe(
        Stream.filter((_) => _[1] === "minor" || _[1] === "major"),
        Stream.map(([, type]) => type),
        Stream.runCollect,
        Effect.map(Array.dedupe),
      )
    const currentMaxType = (packages) =>
      currentTypes(packages).pipe(
        Effect.map((types) => {
          if (types.includes("major")) return Option.some("major")
          else if (types.includes("minor")) return Option.some("minor")
          else if (types.includes("patch")) return Option.some("patch")
          return Option.none()
        }),
      )
    return {
      current,
      currentTypes,
      currentMaxType,
    }
  }),
}) {
  static layerNoDeps = Layer.effect(this, this.make)
  static layer = this.layerNoDeps.pipe(
    Layer.provide(PullRequests.layer),
    Layer.provide(Github.layer),
  )
}
const ChangeRegex = /"(.+?)":\s*(patch|minor|major)/g
const parse = (content) => {
  const root = unified().use(remarkParse).parse(content)
  return Array.findFirst(root.children, (_) => _.type === "heading").pipe(
    Option.flatMap((_) => Array.findFirst(_.children, (_) => _.type === "text")),
    Option.map((_) => [..._.value.matchAll(ChangeRegex)].map(([, pkg, type]) => [pkg, type])),
    Option.getOrElse(() => []),
  )
}
//#endregion
//#region src/Comments.ts
var Comments = class extends Context.Service()("app/Comments", {
  make: Effect.gen(function* () {
    const env = yield* RunnerEnv
    const react = (yield* Github).wrap((_) => _.reactions.createForIssueComment)
    const reactCurrent = (content) =>
      Effect.fromOption(env.comment).pipe(
        Effect.andThen((comment) =>
          react({
            owner: env.repo.owner.login,
            repo: env.repo.name,
            comment_id: comment.id,
            content,
          }),
        ),
      )
    return {
      react,
      reactCurrent,
    }
  }),
}) {
  static layerNoDeps = Layer.effect(this, this.make)
  static layer = this.layerNoDeps.pipe(Layer.provide(Github.layer), Layer.provide(RunnerEnv.layer))
}
//#endregion
//#region src/Git.ts
var GitError = class extends Data.TaggedError("GitError") {
  get message() {
    return this.error.message
  }
}
var GitRepo = class extends Context.Service()("app/GitRepo") {}
const make = ({ simpleGit: opts = {}, userName, userEmail }) => {
  const clone = (url, dir) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => SG.simpleGit(opts).clone(url, dir),
        catch: (error) => new GitError({ error }),
      })
      return yield* open(dir)
    })
  const open = (dir) =>
    Effect.gen(function* () {
      const git = SG.simpleGit(dir, opts)
      const run = (f) =>
        Effect.tryPromise({
          try: () => f(git),
          catch: (error) => new GitError({ error }),
        })
      yield* run((_) => _.addConfig("user.name", userName).addConfig("user.email", userEmail))
      return GitRepo.of({
        git,
        run,
        path: dir,
      })
    })
  return {
    clone,
    open,
  }
}
var Git = class Git extends Context.Service()("app/Git") {
  static layer = (config) => Config.unwrap(config).pipe(Effect.map(make), Layer.effect(Git))
}
//#endregion
//#region src/Permissions.ts
var Permissions = class extends Context.Service()("app/Permissions", {
  make: Effect.gen(function* () {
    const env = yield* RunnerEnv
    const actorCheck = (yield* Github)
      .wrap((_) => _.repos.checkCollaborator)({
        owner: env.repo.owner.login,
        repo: env.repo.name,
        username: env.actor,
      })
      .pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: () => true,
        }),
      )
    const isPullAuthor = env.pull.pipe(
      Option.map((pull) => pull.user.login === env.actor),
      Option.getOrElse(() => false),
    )
    const whenCollaborator = (effect) => Effect.when(effect, actorCheck)
    const whenCollaboratorOrAuthor = (effect) =>
      Effect.when(effect, isPullAuthor ? Effect.succeed(true) : actorCheck)
    return {
      whenCollaborator,
      whenCollaboratorOrAuthor,
    }
  }),
}) {
  static layerNoDeps = Layer.effect(this, this.make)
  static layer = this.layerNoDeps.pipe(Layer.provide(Github.layer), Layer.provide(RunnerEnv.layer))
}
//#endregion
//#region src/Rebase.ts
const runComment = Effect.gen(function* () {
  const comments = yield* Comments
  yield* (yield* Permissions).whenCollaboratorOrAuthor(
    Effect.gen(function* () {
      yield* comments.reactCurrent("eyes")
      yield* runCurrent
      yield* comments.reactCurrent("rocket")
    }).pipe(Effect.tapCause(() => comments.reactCurrent("-1"))),
  )
})
const run$2 = Effect.gen(function* () {
  const git = yield* Git.pipe(Effect.flatMap((_) => _.open(".")))
  const prefix$5 = yield* prefix
  const base = yield* baseBranch
  const fetchOrigin = git.run((_) => _.fetch("origin"))
  yield* fetchOrigin
  yield* Effect.log(`rebasing ${prefix$5}-major on ${prefix$5}-minor`)
  yield* git
    .run((_) =>
      _.checkout(`${prefix$5}-major`)
        .rebase([`origin/${prefix$5}-minor`])
        .push(["--force"]),
    )
    .pipe(
      Effect.tapError((_) => git.run((_) => _.rebase(["--abort"]))),
      Effect.catchCause(Effect.log),
    )
  yield* fetchOrigin
  yield* Effect.log(`rebasing ${prefix$5}-minor on ${base}`)
  yield* git
    .run((_) =>
      _.checkout(`${prefix$5}-minor`)
        .rebase([`origin/${base}`])
        .push(["--force"]),
    )
    .pipe(
      Effect.tapError((_) => git.run((_) => _.rebase(["--abort"]))),
      Effect.catchCause(Effect.log),
    )
  yield* fetchOrigin
  yield* Effect.log(`rebasing ${prefix$5}-major on ${prefix$5}-minor`)
  yield* git
    .run((_) =>
      _.checkout(`${prefix$5}-major`)
        .reset(["--hard", `origin/${prefix$5}-major`])
        .rebase([`origin/${prefix$5}-minor`])
        .push(["--force"]),
    )
    .pipe(
      Effect.tapError((_) => git.run((_) => _.rebase(["--abort"]))),
      Effect.catchCause(Effect.log),
    )
})
const runCurrent = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const gh = yield* Github
  const git = yield* Git.pipe(Effect.flatMap((_) => _.open(".")))
  const prefix$6 = yield* prefix
  const current = yield* (yield* PullRequests).current.pipe(
    Effect.filterOrFail(
      (pull) => pull.base.ref === `${prefix$6}-major` || pull.base.ref === `${prefix$6}-minor`,
    ),
    Effect.option,
  )
  if (Option.isNone(current)) return
  const pull = current.value
  yield* git.run((_) => _.fetch("origin").checkout(pull.base.ref))
  yield* Effect.log(`rebasing #${pull.number} on ${pull.base.ref}`)
  const command = gh.cli("pr", "checkout", "-b", "pr-branch", "--force", pull.number.toString())
  yield* spawner.exitCode(command)
  yield* git.run((_) =>
    _.rebase([pull.base.ref]).push([
      pull.head.repo.clone_url,
      `pr-branch:${pull.head.ref}`,
      "--force",
    ]),
  )
})
//#endregion
//#region src/ReleasePull.ts
const run$1 = Effect.gen(function* () {
  const env = yield* RunnerEnv
  const prefix$4 = yield* prefix
  if (![`${prefix$4}-major`, `${prefix$4}-minor`].includes(env.ref)) return
  const head = env.ref
  const base = head.endsWith("-major") ? `${prefix$4}-minor` : yield* baseBranch
  const git = yield* Git.pipe(Effect.flatMap((_) => _.open(".")))
  if (
    (yield* git.run((_) => _.fetch("origin").revparse(`origin/${head}`))) ===
    (yield* git.run((_) => _.revparse(`origin/${base}`)))
  )
    return
  const changeType = head.endsWith("-major") ? "major" : "minor"
  const pulls = yield* PullRequests
  const body = yield* pullBody(base, head)
  yield* pulls.upsert({
    head,
    base,
    title: `Release queue: ${changeType}`,
    body,
  })
})
const pullBody = (base, head) =>
  Effect.gen(function* () {
    return `Contains the following pull requests:\n\n${(yield* diffPulls(base, head).pipe(
      Stream.runCollect,
      Effect.map((pulls) =>
        pipe(
          pulls,
          Array.dedupeWith((a, b) => a.number === b.number),
          Array.sort(Order.Struct({ number: Order.Number })),
        ),
      ),
    ))
      .map((pull) => `- #${pull.number}`)
      .join("\n")}`
  })
const diffPulls = (base, head) =>
  Effect.gen(function* () {
    const pulls = yield* PullRequests
    const currentNumber = yield* pulls.current.pipe(
      Effect.map((_) => _.number),
      Effect.orElseSucceed(() => 0),
    )
    return diffCommits(base, head).pipe(
      Stream.mapEffect((commit) => pulls.forCommit(commit.sha)),
      Stream.flattenIterable,
      Stream.filter((_) => _.number !== currentNumber),
    )
  }).pipe(Stream.unwrap)
const diffCommits = (base, head) =>
  Effect.gen(function* () {
    const env = yield* RunnerEnv
    return (yield* Github).streamWith(
      (_, page) =>
        _.repos.compareCommits({
          owner: env.repo.owner.login,
          repo: env.repo.name,
          base,
          head,
          page,
        }),
      (_) => _.commits,
    )
  }).pipe(Stream.unwrap)
//#endregion
//#region src/UpdateBase.ts
const run = Effect.gen(function* () {
  const pulls = yield* PullRequests
  const pull = yield* pulls.current
  const prefix$2 = yield* prefix
  if (pull.head.ref.startsWith(`${prefix$2}-`)) return yield* new NoPullRequest()
  const changesets = yield* Changesets
  const packages$1 = yield* packages
  const changeTypeOption = yield* changesets
    .currentMaxType(packages$1)
    .pipe(Effect.map(Option.filter((_) => _ !== "patch")))
  if (Option.isNone(changeTypeOption)) return yield* Console.log("Not a minor or major change")
  const changeType = changeTypeOption.value
  const targetBase = `${prefix$2}-${changeType}`
  if (pull.base.ref === targetBase) return yield* Console.log("No update needed")
  if (changeType === "major") yield* ensureBranchFor("minor")
  yield* ensureBranchFor(changeType)
  yield* pulls.setCurrentBase(targetBase)
  yield* pulls.addCurrentLabels([targetBase])
  yield* Console.log(`Updated base to ${targetBase}`)
})
const getBranch = Effect.fn(function* (branch) {
  const env = yield* RunnerEnv
  return yield* (yield* Github).wrap((_) => _.repos.getBranch)({
    owner: env.repo.owner.login,
    repo: env.repo.name,
    branch,
  })
})
const getDefaultBranch = Effect.flatMap(baseBranch, getBranch)
const ensureBranchFor = Effect.fn(function* (changeType) {
  const env = yield* RunnerEnv
  const github = yield* Github
  const prefix$3 = yield* prefix
  const sha = (
    changeType === "minor" ? yield* getDefaultBranch : yield* getBranch(`${prefix$3}-minor`)
  ).commit.sha
  const ref = `${prefix$3}-${changeType}`
  const create = github.wrap((_) => _.git.createRef)({
    owner: env.repo.owner.login,
    repo: env.repo.name,
    ref: `refs/heads/${ref}`,
    sha,
  })
  yield* getBranch(ref).pipe(
    Effect.catchIf(
      (e) => e.reason.status === 404,
      (_) => create,
    ),
  )
})
//#endregion
//#region src/index.ts
const githubActor = Config.nonEmptyString("github_actor")
const githubActorEmail = githubActor.pipe(Config.map((_) => `${_}@users.noreply.github.com`))
const GitLayer = Git.layer({
  userName: input("git_user").pipe(Config.orElse(() => githubActor)),
  userEmail: input("git_email").pipe(Config.orElse(() => githubActorEmail)),
  simpleGit: Config.succeed({}),
})
const ConfigProviderLayer = ConfigProvider.fromEnv().pipe(
  ConfigProvider.constantCase,
  ConfigProvider.layer,
)
const MainLayer = Layer.mergeAll(
  Changesets.layer,
  Comments.layer,
  Permissions.layer,
  PullRequests.layer,
  RunnerEnv.layer,
  Github.layer,
  GitLayer,
).pipe(Layer.provide(ConfigProviderLayer), Layer.provideMerge(NodeServices.layer))
const main = Effect.gen(function* () {
  const gh = yield* Github
  const env = yield* RunnerEnv
  const baseBranch$1 = yield* baseBranch
  const prefix$1 = yield* prefix
  const eligibleBranches = [`${prefix$1}-major`, `${prefix$1}-minor`]
  const currentUser = (yield* gh.request((_) => _.users.getAuthenticated())).data.login
  yield* Effect.log("Running").pipe(
    Effect.annotateLogs({
      baseBranch: baseBranch$1,
      ref: env.ref,
      actor: env.actor,
      currentUser,
      isPR: Option.isSome(env.pull),
      isComment: Option.isSome(env.comment),
      eligibleBranches,
      isOrigin: env.isOrigin,
    }),
  )
  if (env.comment._tag === "Some" && env.comment.value.body.startsWith("/rebase")) yield* runComment
  else if (eligibleBranches.includes(env.ref) && env.isOrigin) {
    if (env.actor !== currentUser) yield* run$2
    yield* run$1
  } else if (Option.isSome(env.pull))
    yield* run.pipe(Effect.catchTags({ NoPullRequest: () => Console.log("No pull request found") }))
  else if (env.ref === baseBranch$1) yield* run$2
}).pipe(Effect.provide(MainLayer))
NodeRuntime.runMain(main)
//#endregion
export {}
