import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Native crash dumps kept per Crashpad report directory; the newest crashes stay for diagnosis. */
export const CRASH_DUMPS_RETAINED = 50

/**
 * Native crash dumps are local-only (never uploaded), so nothing else consumes and removes them and
 * a crash loop grows the directory without limit. Keep the newest `retain` dumps in each report
 * directory, remove older `.dmp` files there, and touch nothing else. Returns how many were removed.
 * Retention is best effort: a file that cannot be read or removed is skipped, never fatal.
 */
export async function pruneCrashDumps(crashDumpsRoot: string, retain = CRASH_DUMPS_RETAINED): Promise<number> {
  let removed = 0
  for (const directory of ['pending', 'completed', 'new']) {
    const path = join(crashDumpsRoot, directory)
    let names: string[]
    try { names = (await readdir(path)).filter(name => name.endsWith('.dmp')) } catch { continue }
    if (names.length <= retain) continue
    const dated = await Promise.all(names.map(async name => {
      try { return { name, at: (await stat(join(path, name))).mtimeMs } } catch { return null }
    }))
    const older = dated.filter(entry => entry !== null).sort((a, b) => b.at - a.at).slice(retain)
    for (const entry of older) {
      try { await unlink(join(path, entry.name)); removed++ } catch { /* Retention never blocks startup. */ }
    }
  }
  return removed
}
