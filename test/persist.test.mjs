/**
 * Failure-source persistence: the trigger predicate, the readable file name,
 * and the verbatim write. These are the parts that can be wrong silently — a
 * boundary that saves trivial snippets, a name that collides, a source that
 * comes back with different bytes than the interpreter received.
 *
 * @module test/persist.test
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import {
  FAILED_CODE_DIR,
  FAILED_CODE_THRESHOLD_CHARS,
  codeSlug,
  failedCodeFileName,
  persistFailedCode,
  saveFailedCode,
  shouldPersistFailedCode,
} from '../src/persist.js'

/** A temporary directory owned by one test. */
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pyrun-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('the trigger is a real non-zero exit strictly above the threshold', () => {
  const atThreshold = 'x'.repeat(FAILED_CODE_THRESHOLD_CHARS)
  const above = `${atThreshold}x`

  assert.equal(shouldPersistFailedCode(atThreshold, 1), false, 'exactly at the threshold must not save')
  assert.equal(shouldPersistFailedCode(above, 1), true)
  assert.equal(shouldPersistFailedCode(above, 2), true, 'any non-zero code counts, not just 1')
  assert.equal(shouldPersistFailedCode(above, 0), false)
  assert.equal(shouldPersistFailedCode(above, null), false, 'a kill or timeout has no exit code to fail with')
  assert.equal(shouldPersistFailedCode(above, undefined), false)
  assert.equal(shouldPersistFailedCode('', 1), false)
})

test('the name carries the local stamp and a readable first-line slug', () => {
  const now = new Date(2026, 9, 30, 22, 4, 58)
  assert.equal(
    failedCodeFileName('\n\n# fetch parquet, then index it\nimport sys\n', now),
    '20261030-220458-fetch-parquet-then-index-it.py',
  )
})

test('the slug keeps any script, collapses punctuation, and stays bounded', () => {
  assert.equal(codeSlug('# 读取 CSV 文件\n'), '读取-CSV-文件', 'a Chinese first line stays legible')
  assert.equal(codeSlug('  \n\t\n'), 'program', 'an empty program still gets a name')
  assert.equal(codeSlug('"""\nmodule docstring\n'), 'module-docstring', 'a docstring fence does not swallow the name')
  assert.equal(codeSlug('#!/usr/bin/env python\nimport sys\n'), 'import-sys', 'a shebang is not a name')
  assert.equal(codeSlug(`${'a'.repeat(80)}\n`), 'a'.repeat(32))
  assert.equal(codeSlug('---\n'), 'program')
})

test('the source is written verbatim, under a directory created on demand', async t => {
  const root = await scratch(t)
  const dir = join(root, FAILED_CODE_DIR)
  const code = '# 中文注释\r\nprint("你好")\n' + 'x'.repeat(FAILED_CODE_THRESHOLD_CHARS) + '\n'

  const path = await saveFailedCode({ dir, code, now: new Date(2026, 9, 30, 22, 4, 58) })

  assert.ok(isAbsolute(path), 'the reported path is absolute, so the model can pass it to edit')
  assert.equal(path, join(dir, '20261030-220458-中文注释.py'))
  assert.equal(await readFile(path, 'utf8'), code, 'bytes round-trip exactly: no BOM, no added newline')
})

test('a same-second name collision falls back to the content hash instead of truncating', async t => {
  const root = await scratch(t)
  const now = new Date(2026, 9, 30, 22, 4, 58)
  const first = `# same first line\nprint(1)\n${'x'.repeat(FAILED_CODE_THRESHOLD_CHARS)}`
  const second = `# same first line\nprint(2)\n${'x'.repeat(FAILED_CODE_THRESHOLD_CHARS)}`

  const a = await saveFailedCode({ dir: root, code: first, now })
  const b = await saveFailedCode({ dir: root, code: second, now })

  assert.notEqual(a, b)
  assert.match(b, /-same-first-line-[0-9a-f]{8}\.py$/)
  assert.equal(await readFile(a, 'utf8'), first)
  assert.equal(await readFile(b, 'utf8'), second)
})

test('a repeat of the same failure in the same second reuses the hashed name', async t => {
  const root = await scratch(t)
  const now = new Date(2026, 9, 30, 22, 4, 58)
  const code = `# same program\nprint(1)\n${'x'.repeat(FAILED_CODE_THRESHOLD_CHARS)}`

  const first = await saveFailedCode({ dir: root, code, now })
  const second = await saveFailedCode({ dir: root, code, now })
  const third = await saveFailedCode({ dir: root, code, now })

  assert.match(second, /-same-program-[0-9a-f]{8}\.py$/)
  assert.equal(third, second, 'an existing hash-named file already holds this source')
  assert.equal(await readFile(second, 'utf8'), code)
})

test('a storage failure is swallowed, never raised', async t => {
  const root = await scratch(t)
  const blocker = join(root, 'not-a-directory')
  await writeFile(blocker, 'occupied')

  assert.equal(await persistFailedCode({ dir: join(blocker, 'pyrun'), code: 'x'.repeat(3000) }), undefined)
})
