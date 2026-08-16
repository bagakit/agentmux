import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, sep } from 'node:path'
import {
  PASTED_IMAGE_MAX_BYTES,
  PASTED_IMAGE_MIME_TYPES,
  type PastedImage,
  type PastedImageExtension
} from '../shared/contracts.js'
import { pastedDirectory } from './pasted-directory.js'

/**
 * Read one pasted/captured image back as an `<img>`-ready data URI, or null when the path is not a
 * readable pasted image.
 *
 * The trust boundary is the pasted directory itself — the read's whitelist is precisely the write
 * sites' target (see `pasted-directory.ts`). This is the reason the read does NOT go through
 * `WorkspaceFiles`: that root is a workspace, this root is an app-owned directory, and the two must not
 * be merged into one confinement test. Rejections (escape, wrong extension, oversized, absent) return
 * null rather than throw, so the renderer falls back to the plain-text reference instead of a broken
 * `<img>` — but the failure is never silent-into-an-empty-data-URI, which would render as a broken
 * image the user cannot tell from an app bug.
 */
export async function readPastedImage(home: string, path: string): Promise<PastedImage | null> {
  const directory = pastedDirectory(home)
  // Containment is checked against REAL paths, not the lexical `resolve()` alone: `resolve` is pure
  // string math and cannot see a symlink, so a link INSIDE the pasted dir that points outside would
  // pass a lexical `startsWith` and leak foreign bytes (verified exploitable). This mirrors the repo's
  // existing two-layer convention (workspace-files.ts: lexical `localPathWithin` + `realpath`, whose
  // comment names this exact "an intermediate symlink escaping the root still reveals" failure).
  //
  // Both sides are realpath'd: on macOS the directory itself sits under a symlink (`/var` → `/private/var`,
  // and the OS temp dir with it), so resolving only one side would make the two never match and reject a
  // genuine image. `realpath` throws on an absent/unreadable path — caught to null, matching the
  // "absent → null, never an unhandled rejection" semantics the rest of this function keeps. The
  // separator suffix still rejects `pasted-evil` sibling look-alikes and the directory itself.
  let resolved: string
  let realDirectory: string
  try {
    resolved = await realpath(path)
    realDirectory = await realpath(directory)
  } catch {
    return null
  }
  if (!resolved.startsWith(realDirectory + sep)) return null

  // Extension whitelist is the shared SSOT — never re-authored here. `extname` includes the dot.
  const extension = extname(resolved).slice(1).toLowerCase()
  if (!(extension in PASTED_IMAGE_MIME_TYPES)) return null
  const mimeType = PASTED_IMAGE_MIME_TYPES[extension as PastedImageExtension]

  let byteLength: number
  try {
    const stats = await stat(resolved)
    // realpath resolved any symlink, but the target can still be a directory or device file, not a
    // readable image — so the isFile() gate stays.
    if (!stats.isFile()) return null
    byteLength = stats.size
  } catch {
    // Absent / unreadable → null, not an empty data URI.
    return null
  }
  // Size is checked against `stat` BEFORE reading, so an oversized file is refused without ever pulling
  // hundreds of megabytes into the render process.
  if (byteLength === 0 || byteLength > PASTED_IMAGE_MAX_BYTES) return null

  let bytes: Buffer
  try {
    bytes = await readFile(resolved)
  } catch {
    return null
  }
  return {
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`
  }
}
