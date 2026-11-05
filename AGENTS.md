# AGENTS.md

Everything a reader of [README.md](README.md) does not need: the runtime contract, why the
dependencies are placed the way they are, how a release happens, and the one failure that
takes the whole process down.

## What lives where

| Path | What it is |
|---|---|
| `src/index.js` | the host half: tool definition, sandbox wiring, job adapter; no build step |
| `cordis.patch.yml` | the Loader row this package contributes as a bundle layer |
| `test/manifest.test.mjs` | the manifest contract: peer/dev placement, version gate, row name, icon chain |
| `test/save-to.test.mjs` | the `save_to` contract: intent forwarding, observation recording, policy fencing, save-before-spawn |
| `README.md`, `README.zh.md` | user-facing pair, same headings |
| `CHANGELOG.md` | keep-a-changelog; the `[section]` a release ships lives under its version |
| `icon.svg` | Plugins-page tile, 64×64 |

## Runtime contract

`peerDependencies` is the load gate, not decoration. `app-boot` reads `engines.dsh` when
present and otherwise every `@deepseek-ai/dsh-*` peer, evaluates it with
`semver.satisfies(runtime, range, { includePrerelease: true })`, and denies an incompatible
row before the Loader imports it: a stderr warning at boot, and the installer refuses the
version outright unless an exact-version exemption was granted through
`dsh plugin allow-version`. A range edit therefore changes what loads, silently.

| What | Version |
|---|---|
| Contract basis — what the `devDependencies` copies are pinned to | `0.2.1-alpha.1` (tag `dsh-v0.2.1-alpha.1`) |
| Running harness on the author's machine, and the one the tool is exercised on daily | `0.2.2-rc.1` (verified with `dsh --version` on 2026-11-05; the `python` tool in that session is this plugin, so foreground execution is live-tested) |
| Latest upstream as of 2026-11-05 | `0.2.2-rc.1` (tag `dsh-v0.2.2-rc.1`, repo HEAD `fcc0ad46`) |
| `peerDependencies` range `^0.2.0-rc.1` | admits `0.2.0-rc.1` … `0.2.2-rc.1`, rejects every `0.1.x` |

Checked against the 0.2.2-rc.1 sources on 2026-11-05 — every symbol this plugin imports is
still there: `defineTool` (`dsh-tools` schema), `ESCALATION_TARGETS`, `approveEscalation`,
`escalationHintMarker`, `sandboxDenialMarker`, `validateEscalationArgs` (`dsh-sandbox`),
`ctx.shell.execute` / `resolve` / `sandboxMode`, `ctx.shellEnv.collect`,
`ctx.get('sandboxPolicy').resolve({ session })`, and `jobs.start` with
`JobHooks = { cancel, done }`. Two changes to know about: `run` is now called with a
`JobHandle` (a zero-argument producer is still valid JavaScript), and the tool-runtime
scheduler is no longer a module-local `Symbol` — see [Dependency placement](#dependency-placement).

The 0.2.x call shape this plugin relies on:

- **Foreground:** `await ctx.shell.execute(ctx.shell.resolve({ ...request, signal: exec.signal }))`, then `await execution.result()` → `ShellRunResult`. "Foreground" is a property of waiting, not of spawning.
- **Background:** resolve the spec with `onExpiry: 'none'` *before* `jobs.start`, spawn inside the registry's `run` starter, return the hooks. No `exec.signal` — cancellation belongs to the job.
- **Streams:** `execution.observed.stdout/stderr.readFrom(byte)`, exposed as `JobOutputSource`s the registry pumps into the output ring at its own cadence.
- **Sandbox:** `ctx.shell.sandboxMode`, `ctx.get('sandboxPolicy').resolve({ session })`, `ctx.shellEnv.collect(exec)`. A confining executor without `ctx.sandboxPolicy` throws at load.

Reference implementation: `packages/shell/tool-pwsh/src/index.ts` (`startJob`). Its private
helpers are not exported, so `src/index.js` keeps a minimal equivalent (`pythonSources`,
`pythonJob`).

## `save_to`

One host-side write, and it is not a second filesystem abstraction: the save rides the same
two seams `dsh-tool-fs` uses. Opting out of either is a bug `test/save-to.test.mjs` catches.

- `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` before writing. With no
  listener it returns `undefined` and the write is unconditional — today's shipped default:
  `dsh-base` lists `fs-observation-policy` as `disabled: true` since 0.2.2-alpha.2. A
  deployment that flips that row on gets the same read-before-write refusal `write` gets, for
  free, because the intent is forwarded verbatim as `writeText`'s `expected`.
- `ctx.emit('fs/observed', …)` with the version `writeText` returned, after a successful
  save. Without it, a session that saves and then `edit`s the file it just created fails
  `FS_NOT_OBSERVED` ("file has not been read") under an armed policy.
- `writeText(target, code, expected, signal, policy)` — the fifth argument is the **same
  per-call policy** the shell request carries (an approved escalation included). Omitting it
  makes `dsh-fs-sandbox` fall back to the deployment's `process.cwd()` root, which is not
  necessarily the session workspace.
- The base directory is `ctx.get('workingDirectory').ensure(agent, signal)`, falling back to the
  session header cwd — the same resolution `pwsh` and `write` use. The header is immutable, so
  after a `working_directory` call it still names the project the session was opened in; using it
  alone would drop a relative `save_to` (and the program) into a directory the model left. The
  service is optional, so it is read with `ctx.get` rather than added to `inject`.
- Ordering: the save happens before the spawn and before `jobs.start`, so a refused save never
  starts a program and a returned background job id means the file is already on disk. The
  converse does not hold, so a run that throws after a successful save has the path appended to
  the error instead of being reported as "nothing happened".

Two deliberate omissions: `ctx.get('fs')` rather than `inject: ['fs']`, so a composition
without a filesystem backend still loads the tool (the call fails with an explicit message
instead of the whole tool disappearing), and the denial path **edits the caught error's
message** rather than constructing a new one — the pipeline fills `result.error.info.code` only
for the `HarnessError` instance the filesystem raised, so a fresh `Error` (or an `FsError` from
another copy of `dsh-fs`) would silently drop `FS_SANDBOX_DENIED`.

## Dependency placement

`@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-sandbox` are imported at runtime, so they are
declared **twice**: in `peerDependencies` (the host supplies the single live instance) and
pinned exactly in `devDependencies` (a `link:`-installed plugin resolves its imports from
this repository, where the profile fallback layer is not an ancestor, so without a local copy
it fails to load with `ERR_MODULE_NOT_FOUND`). They must never appear in `dependencies`:

- the consuming profile installs a plugin's regular dependencies, and with `nodeLinker: hoisted` it materialises them at the profile root, producing a second physical copy;
- on harness ≤ 0.2.1 that copy mints a second `Symbol('@deepseek-ai/dsh-tools.scheduler')`, so `ctx.tools[...]` is `undefined` and **every** tool call in the process throws `Cannot read properties of undefined (reading 'prepare')`;
- a consuming profile never installs devDependencies, so the dev copy stays inert.

0.2.2-rc.1 removed the module-local scheduler symbol — the executor is registered on the
`ctx.tools` service instance now — so that split no longer applies there. The placement rule
stays: it is still what keeps the profile to one copy, and the peer is still the load gate.

Diagnosis for the ≤ 0.2.1 crash:

```powershell
# Expect False: this copy is the culprit when it exists.
Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-tools"
# Expect one entry, under devDependencies.
pnpm why @deepseek-ai/dsh-tools
# Full inventory: the host install tree has one copy, the profile none.
Get-ChildItem "$env:USERPROFILE\.dsh" -Recurse -Directory -Filter 'dsh-tools' -ErrorAction SilentlyContinue
```

Recovery: move the entry back to `devDependencies`, `pnpm install`, reinstall the plugin in
the profile so pnpm recomputes `node_modules`, then fully restart `dsh` — `patchReload: live`
re-reads the patch, never cached modules.

⚠️ A crash round poisons its session: orphaned `tool_calls` without `tool/result` make every
later turn fail with `INVALID_REQUEST: ... tool calls need immediate results`. Start a new
session; fixing the plugin does not repair the old one.

## Development

- **No build step.** Plain ESM in `src/index.js`, no `prepare` script, so pnpm's build blocking never applies.
- **Tests:** `pnpm test` (`node --test "test/*.test.mjs"`). Keep the glob — `node --test test/` treats the directory as a module on CI and dies with `MODULE_NOT_FOUND`. Inside the DSH sandbox the default process isolation fails on piped-stdio spawn (`spawn EPERM`, a sandbox boundary rather than a test failure); use `node --test --test-isolation=none "test/*.test.mjs"` there.
- **No `@deepseek-ai/dsh-llm` dependency.** `HarnessError` is recognised by `instanceof` in `errorInfo()`, and an in-process plugin holds a different copy, so the check would silently degrade.
- **Icon chain:** `package.json.icon` + `files` + `exports["./package.json"]`. `app-boot`'s `readPluginMeta` resolves the manifest through exports and inlines the icon as a data URL (SVG/PNG/JPEG/WebP, ≤ 256 KiB, relative path inside the package). Drop any half and the Plugins row falls back to default artwork or a metadata error. The manifest is read at startup: restart `dsh` after changing it, and reinstall for `github:`/npm installs.
- **Rename = three places + reinstall:** `package.json.name`, the `name` in `cordis.patch.yml` (the specifier the Loader imports), and `export const name` in `src/index.js`; then remove and re-add the package in the profile so `node_modules/@scope/<new-name>` really exists. A miss is silent: the old link keeps booting, and the first install that materialises the new name leaves only `skipping profile bundle "<old-name>"`.
- **cordis:** peer `^4.0.1` (not a `dsh-*` name, so outside the gate); dev-pinned to the exact version the 0.2.1-alpha.1 family pins, because the local `dsh-tools` / `dsh-sandbox` copies import `Service` from it while loading.

## Release

No `NPM_TOKEN`, no secrets. Publishing is [trusted publishing
(OIDC)](https://docs.npmjs.com/trusted-publishers) plus [staged
publishing](https://docs.npmjs.com/staged-publishing): CI stages the version, you approve it
on npmjs.com with 2FA.

**One-time setup**

1. First publish, because a new package cannot have a Trusted Publisher yet: `npm login` (with 2FA), `npm stage publish`, approve under "Staged Packages" on npmjs.com.
2. npmjs.com → package → Settings → Trusted publishing: GitHub Actions, org `ds-hu`, repo `dsh-plugin-pyrun`, workflow `publish.yml`, allowed action `npm stage publish` (add `npm publish` only if you want `direct` mode). **The binding expires 48 hours after creation** unless a successful publish completes inside it, so create it right before the first release.

**Every release**

```powershell
git tag v0.2.0
git push origin v0.2.0
```

CI runs tests, checks the tag against `package.json.version`, stages the publish, and you
approve with 2FA. `workflow_dispatch` with `direct` skips the approval step.

**Why not tokens:** since 2026-07-31, bypass-2FA granular tokens cannot perform account or
package settings operations, and from 2027-01 they lose direct `npm publish` as well — only
"read private packages" and "stage a publish" remain. Provenance is attached automatically for
a public repo and public package. `repository.url` must match the GitHub repository verbatim
(OIDC verifies it). Only GitHub-hosted runners work: OIDC tokens from `pull_request_target` and
`issue_comment` are rejected, so the workflow hangs off `push` tags and `workflow_dispatch`.
The workflow upgrades npm to 11.21+ because `npm stage publish` needs 11.15+ and the node 24
image's bundled npm is not yours to choose.

## History

This package is the port of the dynamic Cordis plugin `pyrun-1` (final revision `pkg-5`),
written against **0.1.5-rc.2** and moved to **0.2.x**. The 0.1.x world used
`ctx.shell.run()` / `ctx.shell.start()`, a live Agent as the job owner, a `readOutput()`
consuming cursor on the hooks, and `JobOutcome.output`; all of it was deleted in 0.1.7-rc.1
and never came back.

The lesson that cost a round trip: **the running version is not the checked-out version.**
`pkg-4` was written against the checkout's 0.1.6 API (`owner: exec.agent.id`) while the
running 0.1.5-rc.2 demanded a live Agent, and loading it threw
`Cannot read properties of undefined (reading 'Symbol(dsh.scope)')`. `pkg-5`, rewritten
against the running contract, passed everything. 0.2.x later made `owner: SessionId` the
official contract.

Retired workarounds, kept for the next reader:

- **Cross-realm approval** (dynamic-plugin era). A dynamic package ran in a `node:vm` realm, and its request objects failed the API gateway's `isPlainRecord` check because that check compares against the host realm's `prototype`; every escalation silently degraded to `unavailable`. `Object.create(null)` made the objects pass both realms. An in-tree plugin needs none of this — it uses `approveEscalation()` directly.
- **Exit-code collapse.** Under `pwsh -Command`, a native command's non-zero exit collapses to `1` (host behaviour; the built-in `pwsh` tool has it too). The Windows branch appends `; exit $LASTEXITCODE`; bash propagates the code itself, so the command string is split by `process.platform`.
- **stdin injection.** The source goes in over stdin rather than argv: no quoting layer, no 32K command-line limit, `-u` disables buffering, `-X utf8` keeps GBK out of the way.

Still worth fixing upstream: `packages/api/gateway/src/stream-protocol.ts`'s `isPlainRecord`
should tolerate cross-realm objects (the same-named function in
`cordis-host-runner/guard.ts` already does). Any dynamic plugin calling `approval.request()`
or `userQuestions.ask` hits it.

Behaviour matrix measured on `pkg-5` (the port is interface-equivalent):

| Check | Result |
|---|---|
| Encoding round trip (Chinese, emoji, arrows, compared with `repr`) | intact |
| SyntaxError → UTF-8 traceback on stderr, `<stdin>` mode | pass |
| `sys.exit(3)` → `[exit code: 3]` | pass (depends on `; exit $LASTEXITCODE`) |
| Sandbox: write and delete in the workspace / denial outside it with marker and escalation hint | same semantics as `pwsh` |
| Timeout (2 s against a 60 s sleep) → partial output kept | pass |
| Truncation (1.3 MB) → tail kept, spill path reported | pass |
| Escalation: approval panel → wider write succeeds → cleanup | pass |
| Background: id returned at once → incremental `job_output` with `[stderr]` sections | pass |
| Background: waiting timeout → partial output, job still alive | pass |
| Background: `job_kill` → settles `killed`, buffered output still readable | pass |
| Background: non-zero exit → `[status: completed, exit code: 3]` | pass |
| Background: completion notice wakes the agent | pass |
| `timeout_ms` together with `run_in_background` | rejected with an explicit error |
