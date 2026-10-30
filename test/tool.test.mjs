/**
 * Tool wiring for failure-source persistence: a long failing foreground run
 * reports the path it saved, a short one saves nothing, a read-only
 * composition saves nothing, and a background job records the path in its
 * terminal detail.
 *
 * The harness services are faked at their public shape — the same technique the
 * shell executor itself uses for its own tests — so the plugin's own control
 * flow is what is under test, not the host.
 *
 * @module test/tool.test
 */

import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../src/index.js'
import { FAILED_CODE_DIR, FAILED_CODE_THRESHOLD_CHARS } from '../src/persist.js'

/** A program comfortably above the persistence threshold. */
const LONG_CODE = `# parse the sales report\nimport sys\nprint("reading")\nsys.exit(3)\n${'# padding line\n'.repeat(200)}`

/** A program below the threshold: retyping it is cheaper than opening a file. */
const SHORT_CODE = 'import sys\nsys.exit(3)\n'

/** Settled-run shape the fake executor returns for one foreground call. */
function foregroundResult(exitCode) {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    stdout: { text: '', truncated: false },
    stderr: { text: 'boom\n', truncated: false },
  }
}

/** Settled-process shape the fake executor returns: usable as a foreground handle and as a job process. */
function settledProcess(exitCode) {
  const result = foregroundResult(exitCode)
  const empty = { readFrom: fromByte => ({ text: '', nextOffset: fromByte, lossy: false }) }
  return {
    ...result,
    status: 'completed',
    done: Promise.resolve(),
    kill() {},
    observed: { stdout: empty, stderr: empty },
    result: async () => result,
  }
}

/**
 * Mount the plugin against a fake context and hand back the registered tool,
 * the shell specs it received, and the jobs registry (when one is provided).
 */
function mount({ cwd, mode = 'workspace-write', exitCode = 3, jobs } = {}) {
  let tool
  const specs = []
  const ctx = {
    get: name => {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) }
      if (name === 'jobs') return jobs
      return undefined
    },
    tools: { register(definition) { tool = definition } },
    shell: {
      sandboxMode: mode,
      resolve: spec => spec,
      execute: async spec => {
        specs.push(spec)
        return settledProcess(exitCode)
      },
    },
    shellEnv: { collect: () => ({ PATH: 'test' }) },
  }
  apply(ctx)
  return { tool, specs }
}

/** One session identity rooted at `cwd`. */
function execAt(cwd) {
  return {
    agent: { id: 'session-1', session: { header: { cwd } } },
    callId: 'call-1',
    signal: new AbortController().signal,
  }
}

/** A temporary workspace owned by one test. */
async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pyrun-tool-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Whether a path exists, without throwing. */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('a long failing foreground run saves its source and reports the path', async t => {
  const cwd = await workspace(t)
  const { tool, specs } = mount({ cwd })
  const exec = execAt(cwd)

  const value = await tool.execute({ code: LONG_CODE }, exec)

  assert.equal(value.exitCode, 3)
  assert.ok(value.savedCodePath.startsWith(join(cwd, FAILED_CODE_DIR)), 'saved inside the session workspace')
  assert.equal(await readFile(value.savedCodePath, 'utf8'), LONG_CODE, 'the saved file is the exact source')
  assert.equal(specs.length, 1)
  assert.equal(specs[0].stdin, LONG_CODE, 'the interpreter still receives the source over stdin')
  assert.equal(
    tool.output.render({ code: LONG_CODE }, value)[0].text,
    `[stderr]\nboom\n[exit code: 3]\n[code saved: ${value.savedCodePath}]`,
  )
})

test('a short failure is not worth a file', async t => {
  const cwd = await workspace(t)
  const { tool } = mount({ cwd })

  const value = await tool.execute({ code: SHORT_CODE }, execAt(cwd))

  assert.equal(value.savedCodePath, undefined)
  assert.equal(await exists(join(cwd, FAILED_CODE_DIR)), false)
  assert.doesNotMatch(tool.output.render({ code: SHORT_CODE }, value)[0].text, /code saved/)
})

test('a read-only composition writes nothing, however long the program', async t => {
  const cwd = await workspace(t)
  const { tool } = mount({ cwd, mode: 'read-only' })

  const value = await tool.execute({ code: LONG_CODE }, execAt(cwd))

  assert.equal(value.savedCodePath, undefined)
  assert.equal(await exists(join(cwd, FAILED_CODE_DIR)), false)
})

test('a background failure records the saved path in its terminal detail', async t => {
  const cwd = await workspace(t)
  let starter
  const jobs = {
    start(spec) {
      starter = spec
      return 'job-1'
    },
  }
  const { tool } = mount({ cwd, jobs })

  const started = await tool.execute({ code: LONG_CODE, run_in_background: true }, execAt(cwd))
  assert.equal(started.jobId, 'job-1')

  const hooks = starter.run()
  const outcome = await hooks.done

  assert.equal(outcome.status, 'completed')
  const match = outcome.detail.match(/^exit code: 3; code saved: (.+)$/)
  assert.ok(match, `detail names the saved file: ${outcome.detail}`)
  assert.equal(await readFile(match[1], 'utf8'), LONG_CODE)
  assert.equal(await exists(join(cwd, FAILED_CODE_DIR)), true)
})

test('the foreground output contract declares the optional path', () => {
  const { tool } = mount({ cwd: process.cwd() })
  assert.equal(tool.output.schema.properties.savedCodePath?.type, 'string')
  assert.ok(FAILED_CODE_THRESHOLD_CHARS > 0)
})
