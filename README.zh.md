[English](https://github.com/ds-hu/dsh-plugin-pyrun/blob/main/README.md) | 中文

# pyrun

**在 DeepSeek Harness 里一步跑 Python。** 模型写出程序，pyrun 经 stdin 直接交给
`python -X utf8 -u -`：没有 shell 引号层，没有临时脚本，双向 UTF-8；沙箱与提权审批沿用
内置 `pwsh` 工具那一套。

[![npm 版本](https://img.shields.io/npm/v/@ds-hu/dsh-plugin-pyrun.svg)](https://www.npmjs.com/package/@ds-hu/dsh-plugin-pyrun)
[![npm 下载量](https://img.shields.io/npm/dm/@ds-hu/dsh-plugin-pyrun.svg)](https://www.npmjs.com/package/@ds-hu/dsh-plugin-pyrun)
[![ci](https://img.shields.io/github/actions/workflow/status/ds-hu/dsh-plugin-pyrun/ci.yml?branch=main)](https://github.com/ds-hu/dsh-plugin-pyrun/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/ds-hu/dsh-plugin-pyrun.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.x-4b32c3)](AGENTS.md#runtime-contract)

```text
python(code="""from datetime import date
print(f"你好 {date.today()}")""")

→ 你好 2026-11-05
```

## 它替掉的是什么

| 你要做的事 | 现在用内置工具 | 换成 pyrun |
|---|---|---|
| 跑一段代码 | `pwsh` 里 `python -c "…"`，引号逐个转义 | 一次 `python` 调用，源码原样 |
| 跑多行脚本 | 先写 `.py`，再执行，再删掉 | 同一次调用，不留文件 |
| 拿回中文输出 | 回来是 GBK 乱码 | 全链路 UTF-8，emoji 也不走样 |
| 跑十分钟的活 | 调用卡到超时 | `run_in_background: true`，`job_output` 收割 |
| 往工作区外写文件 | 被拒绝，无路可走 | 带审批的一次性 `sandbox_permissions` 重试 |

## 安装

```powershell
dsh plugin --profile web add @ds-hu/dsh-plugin-pyrun
```

装完**重启 `dsh`**：宿主半身是 Node 模块，只在启动时重新加载。Web 侧的 Plugins 页装的
是同一个包。

从源码目录装（开发用）：

```powershell
dsh plugin --profile web add link:D:/Projects/dsh-plugin-pyrun
```

需要 DSH 0.2.x，以及 `PATH` 里的 `python`——插件不探测解释器路径。把 `web` 换成你实际
运行的那个 profile 即可。

## 用法

每次调用就是一个程序。

| 字段 | 作用 |
|---|---|
| `code` | 程序原文，经 stdin 原样执行 |
| `workdir` | 工作目录；缺省用会话 cwd，相对路径按它解析 |
| `timeout_ms` | 前台时限；与后台运行同时出现会被拒绝 |
| `run_in_background` | 立即返回 job id，不设时限 |
| `sandbox_permissions` + `justification` | 对刚被沙箱拒绝的调用做一次性重试 |

返回依次是 stdout、`[stderr]` 分节、标记行：`[exit code: N]`（非零退出码是结果，不是
失败）、`[timed out after Nms]`、`[killed by signal: …]`、
`[output truncated; full output: <path>]`、`[sandbox: file access denied under <mode> mode]`。

后台作业在 `job_list` 里 kind 显示为 `python`，用 `job_output` 收割，用 `job_kill` 停止。

## 已知限制

- 前台超时即杀，**不会**转成后台作业。长跑请在第一次调用就带上 `run_in_background`。
- 程序读不到交互输入——stdin 已经被源码占用。
- 没有配置项：超时与输出上限沿用执行器自己的默认值和上限。

## 更多

运行契约、依赖放置规则、发版流程，以及“所有工具调用一起崩”的排障，见
[AGENTS.md](AGENTS.md)。

MIT
