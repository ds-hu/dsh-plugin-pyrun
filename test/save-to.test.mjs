/**
 * `save_to` contract for dsh-plugin-pyrun.
 *
 * The parameter adds a host-side write that does NOT go through a subprocess,
 * so the assertions here are about the three seams it must ride:
 *
 * - `fs/write-intent` — the deployment's read-before-write policy, if armed,
 *   decides whether this write may replace an existing file. The decision must
 *   reach `writeText`'s `expected` argument; dropping it silently downgrades
 *   the save to an unconditional clobber.
 * - `fs/observed` — a successful save must record the new version, otherwise a
 *   later `edit` of the file this call just created fails as "not read" under
 *   an armed policy.
 * - the per-call sandbox policy — `writeText`'s fifth argument. Omitting it
 *   makes the sandbox backend fall back to the deployment's `process.cwd()`
 *   root instead of the session workspace.
 *
 * The ordering assertion (write before spawn) is the fail-closed half: a
 * refused save must leave the program unstarted.
 *
 * @module test/save-to.test
 */

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { apply } from '../src/index.js'

const SESSION_CWD = 'D:/Projects/ws'
const EFFECTIVE_CWD = 'D:/Projects/ws/sub'
const POLICY = { mode: 'workspace-write', workspaceRoot: SESSION_CWD }

/** The settled foreground result the fake executor hands back. */
const RUN = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  timeoutMs: 60000,
  stdout: { text: 'ok\n', truncated: false },
  stderr: { text: '', truncated: false },
}

/** A tool execution shaped like the host's: an owning session, a call id, an abort signal. */
function execution() {
  return {
    callId: 'call-1',
    signal: new AbortController().signal,
    agent: { id: 'agent-1', session: { header: { cwd: SESSION_CWD } } },
  }
}

/** A `ctx.fs` stub recording every call; `writeText` may be overridden to throw. */
function fakeFs(order, { target = { targetKey: 'key-1', displayPath: 'D:/Projects/ws/notes/x.py' }, writeText } = {}) {
  const calls = []
  return {
    calls,
    async resolve(path, opts) {
      calls.push(['resolve', path, opts])
      return target
    },
    async writeText(...args) {
      calls.push(['writeText', ...args])
      order.push('writeText')
      if (writeText !== undefined) return writeText(...args)
      return { operation: 'create', version: 'v1', before: null, after: 'print(1)' }
    },
    processPath: value => value.displayPath,
  }
}

/**
 * Compose the plugin against a fake context and return the registered `python`
 * definition plus the shared call order.
 */
function harness({ fs, jobs, intent, workingDirectory, shellThrows } = {}) {
  const registered = []
  const emitted = []
  const order = []
  const workdirs = []
  const ctx = {
    shell: {
      sandboxMode: 'workspace-write',
      resolve: spec => {
        workdirs.push(spec.workdir)
        return { ...spec, resolved: true }
      },
      async execute() {
        order.push('execute')
        if (shellThrows !== undefined) throw shellThrows
        return { result: async () => RUN }
      },
    },
    shellEnv: { collect: () => ({ DSH_PROFILE: 'test' }) },
    tools: { register: definition => registered.push(definition) },
    get(name) {
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return { resolve: () => ({ ...POLICY }) }
      if (name === 'jobs') return jobs
      if (name === 'workingDirectory') return workingDirectory
      return undefined
    },
    async waterfall(name, target, actor, next) {
      order.push(`waterfall:${name}`)
      return intent === undefined ? next() : intent(name, target, actor, next)
    },
    emit(name, ...rest) {
      emitted.push([name, ...rest])
    },
  }
  apply(ctx)
  assert.equal(registered.length, 1, 'apply must register exactly the python tool')
  return { tool: registered[0], order, emitted, fs, workdirs }
}

test('save_to is optional: without it the filesystem is never touched', async () => {
  const fs = fakeFs([])
  const { tool, order, emitted } = harness({ fs })

  const value = await tool.execute({ code: 'print(1)' }, execution())

  assert.deepEqual(fs.calls, [], 'an absent save_to must not resolve or write anything')
  assert.deepEqual(emitted, [], 'an absent save_to must not record an observation')
  assert.deepEqual(order, ['execute'], 'the program still runs')
  assert.equal(value.kind, 'foreground')
  assert.equal(value.saved, undefined, 'the saved notice only appears when asked for')
})

test('save_to writes the source before the program runs, through intent and policy', async () => {
  const intent = { kind: 'createIfAbsent' }
  const fs = fakeFs([])
  const { tool, order, emitted } = harness({ fs, intent: () => intent })
  const exec = execution()

  const value = await tool.execute({ code: 'print(1)', save_to: 'notes/x.py', workdir: 'sub' }, exec)

  const [resolveCall] = fs.calls
  assert.equal(resolveCall[0], 'resolve')
  assert.equal(resolveCall[1], 'notes/x.py', 'a relative save_to is handed to the backend unresolved')
  assert.equal(
    resolveCall[2].cwd,
    resolve(SESSION_CWD, 'sub'),
    'save_to resolves against workdir, the same base the program\'s relative paths use',
  )
  assert.equal(resolveCall[2].signal, exec.signal, 'resolution is cancellable with the tool call')

  const writeCall = fs.calls[1]
  assert.equal(writeCall[0], 'writeText')
  assert.equal(writeCall[2], 'print(1)', 'the saved bytes are the source verbatim')
  assert.deepEqual(writeCall[3], intent, 'the policy intent must reach writeText; omitting it turns the save into an unconditional clobber')
  assert.equal(writeCall[4], exec.signal)
  assert.deepEqual(writeCall[5], POLICY, 'the per-call sandbox policy must fence this write, not the deployment fallback')

  assert.ok(
    order.indexOf('writeText') < order.indexOf('execute'),
    'the save must land before the spawn, so a refused save never starts the program',
  )
  assert.deepEqual(
    emitted,
    [['fs/observed', { targetKey: 'key-1', displayPath: 'D:/Projects/ws/notes/x.py' }, { kind: 'present', version: 'v1' }, exec]],
    'a successful save records the version so the session can edit its own file',
  )
  assert.deepEqual(value.saved, { path: 'D:/Projects/ws/notes/x.py', operation: 'create' })
})

test('a relative save_to follows the session\'s effective working directory', async () => {
  const ensureCalls = []
  const fs = fakeFs([])
  const { tool, workdirs } = harness({
    fs,
    workingDirectory: {
      async ensure(agent, signal) {
        ensureCalls.push([agent, signal])
        return EFFECTIVE_CWD
      },
    },
  })
  const exec = execution()

  const value = await tool.execute({ code: 'print(1)', save_to: 'x.py' }, exec)

  assert.deepEqual(
    ensureCalls,
    [[exec.agent, exec.signal]],
    'the base is resolved the way pwsh and write resolve it, not from the immutable session header',
  )
  assert.equal(fs.calls[0][2].cwd, EFFECTIVE_CWD, 'the file lands in the directory the model is operating in')
  assert.equal(workdirs[0], EFFECTIVE_CWD, 'the program runs there too, so the save lands beside it')
  assert.deepEqual(value.saved, { path: 'D:/Projects/ws/notes/x.py', operation: 'create' })
})

test('an explicit relative workdir resolves against the effective directory', async () => {
  const fs = fakeFs([])
  const { tool, workdirs } = harness({
    fs,
    workingDirectory: { ensure: async () => EFFECTIVE_CWD },
  })

  await tool.execute({ code: 'print(1)', workdir: 'pkg', save_to: 'x.py' }, execution())

  assert.equal(workdirs[0], resolve(EFFECTIVE_CWD, 'pkg'))
  assert.equal(fs.calls[0][2].cwd, resolve(EFFECTIVE_CWD, 'pkg'))
})

test('a guarded refusal aborts the call before the program runs', async () => {
  const refusal = Object.assign(
    new Error('cannot overwrite existing "notes/x.py" without reading it first'),
    { code: 'FS_NOT_OBSERVED' },
  )
  const fs = fakeFs([], { writeText: () => { throw refusal } })
  const { tool, order, emitted } = harness({ fs, intent: () => ({ kind: 'createIfAbsent' }) })

  await assert.rejects(
    () => tool.execute({ code: 'print(1)', save_to: 'notes/x.py' }, execution()),
    /without reading it first/,
  )

  assert.equal(order.includes('execute'), false, 'a refused save must not start the program')
  assert.deepEqual(emitted, [], 'a refused save must not record an observation')
})

test('a sandbox refusal reaches the model as the shared marker plus the escalation hint', async () => {
  const denial = Object.assign(
    new Error('cannot write "D:/elsewhere/x.py": file access denied under workspace-write mode'),
    { code: 'FS_SANDBOX_DENIED' },
  )
  const fs = fakeFs([], { writeText: () => { throw denial } })
  const { tool, order } = harness({ fs })

  await assert.rejects(
    () => tool.execute({ code: 'print(1)', save_to: 'D:/elsewhere/x.py' }, execution()),
    error => {
      assert.match(error.message, /^\[sandbox: file access denied under workspace-write mode\]/)
      assert.match(error.message, /retry this exact operation once with sandbox_permissions \(the narrowest wider mode/)
      assert.equal(
        error.code,
        'FS_SANDBOX_DENIED',
        'the structured code must survive: the pipeline reports result.error.info.code only for this error instance',
      )
      return true
    },
  )
  assert.equal(order.includes('execute'), false)
})

test('a run that fails after a successful save still names the file', async () => {
  const fs = fakeFs([])
  const failure = Object.assign(new Error('executor unavailable'), { code: 'SHELL_UNAVAILABLE' })
  const { tool } = harness({ fs, shellThrows: failure })

  await assert.rejects(
    () => tool.execute({ code: 'print(1)', save_to: 'notes/x.py' }, execution()),
    error => {
      assert.match(error.message, /executor unavailable/)
      assert.ok(
        error.message.endsWith('[saved to D:/Projects/ws/notes/x.py]'),
        'the model must learn the file exists even though the call failed',
      )
      assert.equal(error.code, 'SHELL_UNAVAILABLE', 'annotating must not replace the error or drop its code')
      return true
    },
  )
})

test('a background call saves at submit time, before the job is admitted', async () => {
  const order = []
  const fs = fakeFs(order)
  const jobs = {
    start(job) {
      order.push('jobs.start')
      assert.equal(typeof job.run, 'function')
      return 'job-1'
    },
  }
  const { tool } = harness({ fs, jobs })

  const value = await tool.execute({ code: 'print(1)', save_to: 'notes/x.py', run_in_background: true }, execution())

  assert.ok(
    order.indexOf('writeText') < order.indexOf('jobs.start'),
    'the file must exist by the time the caller holds a job id',
  )
  assert.deepEqual(value, {
    kind: 'background',
    jobId: 'job-1',
    saved: { path: 'D:/Projects/ws/notes/x.py', operation: 'create' },
  })
})

test('save_to without a filesystem backend fails loudly instead of silently dropping the save', async () => {
  const { tool } = harness({ fs: undefined })

  await assert.rejects(
    () => tool.execute({ code: 'print(1)', save_to: 'notes/x.py' }, execution()),
    /save_to is unavailable: this composition mounts no ctx\.fs backend/,
  )
})

test('an unsupported background call saves nothing before refusing', async () => {
  const fs = fakeFs([])
  const { tool, order } = harness({ fs })

  await assert.rejects(
    () => tool.execute({ code: 'print(1)', save_to: 'notes/x.py', run_in_background: true }, execution()),
    /background jobs unavailable/,
  )
  assert.deepEqual(fs.calls, [], 'a call the composition cannot serve must not leave a file behind')
  assert.deepEqual(order, [])
})

test('the model-facing schema advertises save_to and the saved notice on every output branch', () => {
  const { tool } = harness({ fs: fakeFs([]), jobs: { start: () => 'job-1' } })

  assert.ok(tool.parameters.properties.save_to, 'an undeclared parameter never reaches execute')
  const branches = tool.output.schema.oneOf ?? [tool.output.schema]
  assert.equal(branches.length, 2, 'a background-capable composition advertises both branches')
  for (const branch of branches) {
    assert.ok(
      branch.properties.saved,
      `the ${branch.properties.kind.const} branch must declare the notice it can return, or the value fails output validation`,
    )
  }
})

test('an empty save_to is rejected before anything happens', async () => {
  const fs = fakeFs([])
  const { tool, order } = harness({ fs })

  await assert.rejects(
    () => tool.execute({ code: 'print(1)', save_to: '   ' }, execution()),
    /invalid save_to: expected a non-empty path/,
  )
  assert.deepEqual(fs.calls, [])
  assert.deepEqual(order, [])
})
