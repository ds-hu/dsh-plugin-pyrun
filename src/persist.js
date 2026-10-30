/**
 * Failure-source persistence for `dsh-plugin-pyrun`.
 *
 * A failing program longer than {@link FAILED_CODE_THRESHOLD_CHARS} is written
 * verbatim to a `.py` file under the session workspace, so a later attempt can
 * edit that file instead of reconstructing the program from the transcript. The
 * module holds no Cordis dependency: the file naming, the trigger predicate, and
 * the write are plain functions, testable with `node --test`.
 *
 * Best effort by contract: a storage failure (permissions, ENOSPC, a read-only
 * filesystem) is reported as `undefined`, never as a tool failure — the settled
 * run stays the result it was.
 *
 * @module dsh-plugin-pyrun/persist
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Session-cwd-relative directory that receives persisted failures. */
export const FAILED_CODE_DIR = join('.dsh', 'pyrun')

/** Character count above which a failing program is worth persisting. */
export const FAILED_CODE_THRESHOLD_CHARS = 2000

/** Longest slug kept in the file name; the rest is dropped. */
const SLUG_MAX_CHARS = 32

/** How many opening non-empty lines the slug may look through for words. */
const SLUG_SCAN_LINES = 5

/** Fallback slug when no opening line carries letters or digits. */
const SLUG_FALLBACK = 'program'

/**
 * Whether a settled run's source should be persisted: a real non-zero exit
 * code (a kill or timeout leaves it `null`) and a source long enough that
 * retyping it is the expensive part of the retry. The comparison is strictly
 * greater, matching the threshold's meaning.
 *
 * @param code The exact source handed to the interpreter.
 * @param exitCode The interpreter's exit code, or `null` when it did not exit.
 * @returns `true` when the source should be written.
 */
export function shouldPersistFailedCode(code, exitCode) {
  return typeof exitCode === 'number' && exitCode !== 0 && code.length > FAILED_CODE_THRESHOLD_CHARS
}

/** Two-digit zero padding. */
const pad = value => String(value).padStart(2, '0')

/**
 * Local-time stamp `YYYYMMDD-HHmmss`, so a directory listing sorts by run and
 * the user recognises "yesterday afternoon" without decoding a UTC offset.
 *
 * @param now The instant to stamp.
 * @returns The compact local timestamp.
 */
export function fileStamp(now) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Derive a readable slug from the source's opening lines: the first line that
 * carries letters or digits wins, so a leading docstring fence, a shebang, or a
 * rule of dashes does not swallow the name. Letters and digits survive (any
 * script, so a Chinese comment stays legible), every other run collapses to one
 * `-`, and the result is bounded. The name is a hint for the human browsing the
 * directory; the timestamp makes it unique.
 *
 * @param code The exact source handed to the interpreter.
 * @returns One filesystem-safe slug, never empty.
 */
export function codeSlug(code) {
  const lines = code.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  for (const line of lines.slice(0, SLUG_SCAN_LINES)) {
    if (line.startsWith('#!')) continue
    const words = line.match(/[\p{L}\p{N}]+/gu) ?? []
    // Slice by code point: an astral letter would otherwise be cut mid-pair.
    const slug = Array.from(words.join('-')).slice(0, SLUG_MAX_CHARS).join('').replace(/-+$/, '')
    if (slug.length > 0) return slug
  }
  return SLUG_FALLBACK
}

/**
 * The file name for one persisted failure: `<stamp>-<slug>.py`. Two runs of
 * different programs inside the same second and with the same first line would
 * collide, which the writer resolves by appending the source hash.
 *
 * @param code The exact source handed to the interpreter.
 * @param now The instant to stamp.
 * @returns The file name, without a directory.
 */
export function failedCodeFileName(code, now) {
  return `${fileStamp(now)}-${codeSlug(code)}.py`
}

/** Short content hash used only to break a same-second name collision. */
function codeHash(code) {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 8)
}

/**
 * Write the failing source verbatim to `dir`, creating the directory when it
 * is missing. The file is created exclusively, so a concurrent writer cannot
 * be silently truncated; a same-second name collision falls back to the
 * content hash. Rejects only on a real storage failure.
 *
 * @param options - the target directory, the exact source, and the stamp.
 * @returns The absolute path written.
 */
export async function saveFailedCode({ dir, code, now = new Date() }) {
  const name = failedCodeFileName(code, now)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  try {
    await writeFile(path, code, { encoding: 'utf8', flag: 'wx' })
    return path
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const alternate = join(dir, name.replace(/\.py$/, `-${codeHash(code)}.py`))
    try {
      await writeFile(alternate, code, { encoding: 'utf8', flag: 'wx' })
      return alternate
    } catch (again) {
      // A third identical run in the same second already wrote this path; the
      // hash names the content, so the existing file is that same source.
      if (again?.code === 'EEXIST') return alternate
      throw again
    }
  }
}

/**
 * Persist a failing source on a best-effort basis: any storage failure is
 * swallowed and reported as `undefined`, because bookkeeping must never turn a
 * settled run into an error.
 *
 * @param options - the target directory and the exact source.
 * @returns The absolute path written, or `undefined` when nothing was saved.
 */
export async function persistFailedCode({ dir, code, now = new Date() }) {
  try {
    return await saveFailedCode({ dir, code, now })
  } catch {
    return undefined
  }
}
