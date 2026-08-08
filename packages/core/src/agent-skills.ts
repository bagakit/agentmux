import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parse } from 'yaml'
import type { AgentCatalogEntry } from './types.js'

export type AgentSkill = { name: string; description: string; path: string; source: 'project' | 'user' }

/** Read actual SKILL.md files, including linked directories, without executing any skill content. */
export async function discoverAgentSkills(input: {
  catalog: AgentCatalogEntry; workspacePath: string; home: string
}): Promise<AgentSkill[]> {
  const found: AgentSkill[] = []
  const seen = new Set<string>()
  async function visit(directory: string, source: AgentSkill['source'], depth = 0): Promise<void> {
    if (depth > 6 || seen.size >= 2048) return
    let physical: string
    try { physical = await realpath(directory) } catch { return }
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
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) await visit(join(directory, entry.name), source, depth + 1)
    }
  }
  for (const [base, source] of [[input.workspacePath, 'project'], [input.home, 'user']] as const) {
    for (const root of input.catalog.composer?.skillRoots ?? []) await visit(join(base, root), source)
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}
