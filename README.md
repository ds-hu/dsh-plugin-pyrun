English | [中文](https://github.com/ds-hu/dsh-plugin-pyrun/blob/main/README.zh.md)

# pyrun

**Run Python in DeepSeek Harness with one tool call.** The model writes the program;
pyrun hands it to `python -X utf8 -u -` on stdin — no shell quoting layer, no temporary
script, UTF-8 on both streams, under the same sandbox and approval rules as the built-in
`pwsh` tool.

[![npm version](https://img.shields.io/npm/v/@ds-hu/dsh-plugin-pyrun.svg)](https://www.npmjs.com/package/@ds-hu/dsh-plugin-pyrun)
[![npm downloads](https://img.shields.io/npm/dm/@ds-hu/dsh-plugin-pyrun.svg)](https://www.npmjs.com/package/@ds-hu/dsh-plugin-pyrun)
[![ci](https://img.shields.io/github/actions/workflow/status/ds-hu/dsh-plugin-pyrun/ci.yml?branch=main)](https://github.com/ds-hu/dsh-plugin-pyrun/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/ds-hu/dsh-plugin-pyrun.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.x-4b32c3)](AGENTS.md#runtime-contract)

```text
python(code="""from datetime import date
print(f"你好 {date.today()}")""")

→ 你好 2026-11-05
```

## What it deletes

| You need to | Built-in route today | With pyrun |
|---|---|---|
| Run a snippet | `pwsh` → `python -c "…"` → escape every quote | one `python` call, source verbatim |
| Run a multi-line script | write a `.py` file, run it, delete it | the same call, no file left behind |
| Get Chinese output back | GBK mangling on the way home | UTF-8 end to end, emoji included |
| Keep a program that worked | nothing: copy it out of the transcript by hand | `save_to: 'scripts/report.py'` writes exactly what ran |
| Run a ten-minute job | the call blocks until the timeout | `run_in_background: true`, collect with `job_output` |
| Write outside the workspace | denied, no way forward | one-shot `sandbox_permissions` retry with approval |

## Install

```powershell
dsh plugin --profile web add @ds-hu/dsh-plugin-pyrun
```

Then **restart `dsh`**: the host half is a Node module and is only re-read at startup.
The Plugins page in the Web UI installs the same package.

From a checkout, for development:

```powershell
dsh plugin --profile web add link:D:/Projects/dsh-plugin-pyrun
```

Requires DSH 0.2.x and `python` on `PATH` — the plugin does not probe for an interpreter.
Swap `web` for the profile you actually run.

## Use

Every call is one program.

| Field | What it is for |
|---|---|
| `code` | the program, executed verbatim through stdin |
| `workdir` | working directory; defaults to the session's current one, and a relative path resolves against it |
| `save_to` | save the source to a file before the run; atomic, parent directories created, fenced by the session's file policy |
| `timeout_ms` | foreground budget; rejected together with a background run |
| `run_in_background` | returns a job id at once; no timeout applies |
| `sandbox_permissions` + `justification` | one-shot retry of a call the sandbox just denied |

Output is stdout, then a `[stderr]` section, then markers: `[saved to <path>]`, `[exit code: N]`
(a non-zero exit is a result, not a failure), `[timed out after Nms]`, `[killed by signal: …]`,
`[output truncated; full output: <path>]`, `[sandbox: file access denied under <mode> mode]`.

`save_to` writes through the session filesystem, so the session's file policy decides: refused
under `read-only`, confined to the workspace under `workspace-write`, and — in a deployment that
enables the read-before-write policy — refused when the target exists and this session has not
read it. The save happens before the program starts: a refused save never runs anything, and a
returned job id means the file is already on disk.

Background jobs appear in `job_list` with kind `python`, are read with `job_output`, and
stopped with `job_kill`.

## Limits

- A foreground timeout kills the program; it never promotes to a background job. For long
  work, pass `run_in_background` on the first call.
- The program cannot read interactive input — stdin carries the source.
- A saved file is not the same execution environment: `python -` runs with `sys.path[0]` at the
  cwd and `__file__` as `<stdin>`; running the same file from disk later changes both (imports
  of sibling modules start resolving).
- No config surface: the executor's own defaults and caps decide timeouts and output limits.

## More

Runtime contract, dependency placement, release process, and the "every tool call fails"
troubleshooting live in [AGENTS.md](AGENTS.md).

MIT
