import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type ProjectAppearance = { kind: 'repository' | 'directory'; icon: string | null }

// The renderer's CSP is `img-src 'self' data:` (no `file:`), so a filesystem path in an <img src>
// never loads — the only channel is a data: URI encoded here in Main. Cap the size BEFORE reading the
// whole file: these bytes come from arbitrary user repositories, so an unbounded read is a memory DoS.
const MAX_ICON_BYTES = 256 * 1024
// Real icons were measured 3–4 path segments deep (`apps/desktop/resources/icon.png`,
// `frontend/public-shell/icons/icon-192.png`), so a fixed prefix list alone scores 0/10 — it needs a
// bounded walk too. Descend at most this many directory levels below the root.
const MAX_DIR_DEPTH = 3
// A bounded-depth walk can still be expensive on a huge or network-mounted tree; cap the dirs scanned
// and degrade to the folder glyph rather than hang. ponytail: fixed cap, make it configurable only if a
// real repo is ever found to hide its icon past dir #400.
const MAX_DIRS_SCANNED = 400
// Never walk into these: node_modules is enormous, the rest are build output or nested worktrees whose
// icons are not this project's identity. Removing this set is a measured regression (test guards it).
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '.worktrees'])
// Conventional locations, tried before the walk so the common case costs a handful of stats, not a BFS.
const FIXED_CANDIDATES = [
  'icon.png', 'icon.svg', 'logo.svg', 'logo.png', 'favicon.svg', 'favicon.ico', 'favicon.png',
  'public/favicon.svg', 'public/favicon.ico', 'public/favicon.png', 'public/logo.svg', 'public/logo.png', 'public/icon.png',
  'app/icon.png', 'src-tauri/icons/icon.png', 'resources/icon.png', 'resources/icon-128.png', 'assets/icon.png',
  'static/favicon.ico', 'static/favicon.png'
]
// Filenames that read as "this is the project's mark". Covers `favicon-192.png`, `icon-512.webp`, etc.
const ICON_NAME = /^(icon|logo|favicon|appicon|app-icon|apple-touch-icon)([-.].*)?\.(png|svg|ico|jpe?g|gif|webp)$/i

/**
 * Sniff the image format from magic bytes — never trust the extension. A repo can ship `logo.png` that
 * is actually text (or a JPEG named `.png`); trusting the extension would encode garbage as image/png
 * and the renderer would show a broken image with no way to tell why.
 */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon'
  // SVG has no binary signature; it is XML text. Accept it only if `<svg` actually appears near the top.
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 1024))
  if (/^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

type Hit = { icon: string; winner: string; winnerSig: string }

async function fileSig(path: string): Promise<string | null> {
  try { const info = await stat(path); return info.isFile() ? `${info.mtimeMs}:${info.size}` : null } catch { return null }
}

/** Encode one candidate if it is a real, small-enough image. Returns null so callers try the next. */
async function tryFile(path: string): Promise<Hit | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_ICON_BYTES) return null // size cap BEFORE reading the bytes
    const bytes = await readFile(path)
    const mime = sniffImageMime(bytes)
    if (!mime) return null
    return { icon: `data:${mime};base64,${bytes.toString('base64')}`, winner: path, winnerSig: `${info.mtimeMs}:${info.size}` }
  } catch { return null }
}

async function findIcon(root: string): Promise<Hit | null> {
  for (const candidate of FIXED_CANDIDATES) {
    const hit = await tryFile(join(root, candidate))
    if (hit) return hit
  }
  // Breadth-first so shallower icons win; the fixed list already handled the conventional exact paths.
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  let scanned = 0
  while (queue.length > 0 && scanned < MAX_DIRS_SCANNED) {
    const { dir, depth } = queue.shift()!
    scanned += 1
    // No annotation: `readdir` is overloaded, and naming the return type picks the Buffer-flavoured
    // overload — `entry.name` then types as Buffer and every use of it below fails. Control-flow
    // inference from the call site gets `Dirent[]` right (same shape as core's agent-skills.ts).
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    // Sort for a deterministic winner across filesystems; conventional names sort ahead of the rest.
    const files = entries.filter((entry) => entry.isFile() && ICON_NAME.test(entry.name)).map((entry) => entry.name).sort()
    for (const name of files) {
      const hit = await tryFile(join(dir, name))
      if (hit) return hit
    }
    if (depth < MAX_DIR_DEPTH) {
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
      }
    }
  }
  return null
}

type CacheEntry = { appearance: ProjectAppearance; rootMtime: number; winner: string | null; winnerSig: string | null; probedAt: number }
const cache = new Map<string, CacheEntry>()
// A permanently stale icon is a small lie that never heals, so the cache re-validates on every hit:
// (1) if a root-level entry was added/removed the root dir mtime changes → full re-probe (catches a
// newly-added `public/` or top-level icon at once); (2) if the winning icon file was changed or deleted
// its signature no longer matches → re-probe. A deep icon added under an unchanged tree heals when this
// TTL lapses. ponytail: TTL ceiling; drop to an fs.watch per project only if 60s ever feels stale.
const CACHE_TTL_MS = 60_000

/** Probe a project root for its own icon, magic-byte-verified and encoded as a data: URI; cached. */
export async function projectAppearance(root: string): Promise<ProjectAppearance> {
  let rootMtime: number
  try { rootMtime = (await stat(root)).mtimeMs } catch { return { kind: 'directory', icon: null } }

  const cached = cache.get(root)
  if (
    cached &&
    Date.now() - cached.probedAt < CACHE_TTL_MS &&
    cached.rootMtime === rootMtime &&
    (cached.winner === null || (await fileSig(cached.winner)) === cached.winnerSig)
  ) {
    return cached.appearance
  }

  let kind: ProjectAppearance['kind'] = 'directory'
  try { await stat(join(root, '.git')); kind = 'repository' } catch { /* ordinary folder */ }
  const hit = await findIcon(root)
  const appearance: ProjectAppearance = { kind, icon: hit?.icon ?? null }
  cache.set(root, { appearance, rootMtime, winner: hit?.winner ?? null, winnerSig: hit?.winnerSig ?? null, probedAt: Date.now() })
  return appearance
}
