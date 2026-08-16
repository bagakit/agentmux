import { readdir, readFile, realpath } from 'node:fs/promises'
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

/** Read actual SKILL.md files, including linked directories, without executing any skill content. */
export async function discoverAgentSkills(input: {
  catalog: AgentCatalogEntry; workspacePath: string; home: string
}): Promise<AgentSkill[]> {
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
  for (const [base, source] of [[input.workspacePath, 'project'], [input.home, 'user']] as const) {
    for (const root of input.catalog.composer?.skillRoots ?? []) await visit(join(base, root), source)
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}
