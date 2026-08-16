import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parse } from 'yaml'
import type { AgentCatalogEntry } from './types.js'

export type AgentSkill = { name: string; description: string; path: string; source: 'project' | 'user' }

// Directories that never hold a skill but are enormous or noise: dependency trees, VCS internals and
// build output. Without this prune, discovery walks the whole workspace — a real repo's node_modules
// alone was measured at 68% of its directories, turning an 85ms scan into ~6s finding 0 extra skills.
// This is the SAME measured set as apps/desktop/src/main/project-appearance.ts (SKIP_DIRS); it is
// duplicated rather than imported because packages/core must not depend on the desktop app (AGENTS.md).
// Keep the two in sync.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '.worktrees'])
// A skill sits a level or two under a declared root (`<root>/<name>/SKILL.md`), so the declared roots are
// already the "conventional locations" — no separate fixed-candidate list is needed. This depth cap only
// stops a stray symlink or a mislabelled root from turning discovery into a full-tree descent.
const MAX_DEPTH = 6
// Hard ceiling on directories visited so a pathological tree degrades to "fewer skills", never a hang.
const MAX_DIRS = 2048

/** Walk the declared skill roots for actual SKILL.md files, without executing any skill content. */
async function walkSkills(bases: readonly (readonly [string, AgentSkill['source']])[], roots: readonly string[]): Promise<AgentSkill[]> {
  const found: AgentSkill[] = []
  const seen = new Set<string>()
  async function visit(directory: string, source: AgentSkill['source'], depth = 0): Promise<void> {
    if (depth > MAX_DEPTH || seen.size >= MAX_DIRS) return
    let physical: string
    try { physical = await realpath(directory) } catch { return }
    // check+add is synchronous, so even the concurrent sibling walk below visits each physical dir once.
    if (seen.has(physical)) return
    seen.add(physical)
    try {
      const text = await readFile(join(directory, 'SKILL.md'), 'utf8')
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
      const data = frontmatter ? parse(frontmatter) : {}
      found.push({
        name: typeof data?.name === 'string' ? data.name : basename(directory),
        description: typeof data?.description === 'string' ? data.description : '',
        path: join(directory, 'SKILL.md'), source
      })
      return
    } catch { /* Containers and invalid skill files do not prevent discovering their siblings. */ }
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    // Concurrent, not serial: sibling skill directories are independent reads. Pruned first — SKIP_DIRS
    // is the difference between a scan proportional to real skill directories and one proportional to the
    // whole workspace.
    await Promise.all(entries.flatMap((entry) => (
      (entry.isDirectory() || entry.isSymbolicLink()) && !SKIP_DIRS.has(entry.name)
        ? [visit(join(directory, entry.name), source, depth + 1)]
        : []
    )))
  }
  // Roots are walked project-before-user so a skill reachable from both wins its `project` source; the
  // `seen` set then keeps the user walk from re-visiting a directory the project walk already claimed.
  for (const [base, source] of bases) {
    for (const root of roots) await visit(join(base, root), source)
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

// 打开菜单不是"目录变了"的证据；只有目录真的变了才重新发现（设计 SSOT）. The freshness signature is the
// mtime of each declared skill-root directory: adding or removing a skill changes its root's mtime, so a
// changed set re-discovers at once while an unchanged one is served from cache — the same rootMtime model
// as project-appearance.ts. Two changes it cannot catch by root mtime alone — an edit to an existing
// SKILL.md's frontmatter, and a skill added below a root's direct child — heal when the TTL lapses.
// This lives in Core, not in the composer component: the component's inputs (workspace/provider) mutate
// in place without a remount, so it cannot tell a re-open apart from a real change. Both entry points
// (Session-side and Workspace-side) call this one function, so both share the one cache and one strategy.
// ponytail: TTL ceiling + unbounded Map keyed by workspace/home/roots; both mirror project-appearance and
// are bounded by real usage. Drop to an fs.watch only if 60s ever feels stale.
type CacheEntry = { skills: AgentSkill[]; signature: string; at: number }
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000

async function rootSignature(rootPaths: readonly string[]): Promise<string> {
  const parts = await Promise.all(rootPaths.map(async (path) => {
    try { return `${path}\n${(await stat(path)).mtimeMs}` } catch { return `${path}\n-` }
  }))
  return parts.join('|')
}

/** Discover an Agent's referenceable skills, memoized so a menu re-open with unchanged folders is free. */
export async function discoverAgentSkills(input: {
  catalog: AgentCatalogEntry; workspacePath: string; home: string
}): Promise<AgentSkill[]> {
  const roots = input.catalog.composer?.skillRoots ?? []
  const bases = [[input.workspacePath, 'project'], [input.home, 'user']] as const
  const rootPaths = bases.flatMap(([base]) => roots.map((root) => join(base, root)))
  // Newline joins the key parts: it cannot occur in a single path segment, so distinct inputs never
  // collide onto one cache key (a space delimiter could, since paths may legitimately contain spaces).
  const key = [input.workspacePath, input.home, ...roots].join('\n')

  const signature = await rootSignature(rootPaths)
  const cached = cache.get(key)
  if (cached && cached.signature === signature && Date.now() - cached.at < CACHE_TTL_MS) return cached.skills

  const skills = await walkSkills(bases, roots)
  cache.set(key, { skills, signature, at: Date.now() })
  return skills
}
