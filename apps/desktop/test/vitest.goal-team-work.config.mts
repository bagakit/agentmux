import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import original from './vitest.goal-identities.config.mts'

const root = process.cwd(), mutation = process.env.GOAL_TEAM_WORK_MUTANT ? JSON.parse(process.env.GOAL_TEAM_WORK_MUTANT) : null
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...original, root, plugins: [...original.plugins ?? [], {
  name: 'goal-team-work-loaded-source', enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (id.includes('?') || !/\.(?:tsx?|m?js)$/u.test(id)) return
    const path = relative(root, id)
    if (!path.startsWith('apps/') && !path.startsWith('packages/')) return
    const originalSHA256 = hash(source)
    if (mutation?.path === path) {
      if (source.split(mutation.anchor).length !== 2) throw Error('Exact original Team owner anchor required: ' + mutation.id)
      source = source.replace(mutation.anchor, () => mutation.replacement)
    }
    if (process.env.GOAL_TEAM_WORK_LOADED) {
      const row = { path, realpath: realpathSync(id), originalSHA256, loadedSHA256: hash(source), mutant: mutation?.path === path ? mutation.id : null }
      source = `import { appendFileSync as __teamWorkLoaded } from 'node:fs'; __teamWorkLoaded(${JSON.stringify(process.env.GOAL_TEAM_WORK_LOADED)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
    }
    return source
  }
}], test: { ...original.test, root: resolve(root), include: [
  'apps/desktop/test/goal-team-references.test.tsx', 'apps/desktop/test/goal-team-focus-card.test.tsx',
  'apps/desktop/test/goal-team-identities.test.tsx', 'apps/desktop/test/goal-agent-work-modes.test.tsx', 'apps/desktop/test/global-board-demand-workspace.test.tsx'
], passWithNoTests: false } }
