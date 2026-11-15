import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import current from './vitest.goal-current-work.config.mts'
const owners = new Set(['packages/core/src/sharing.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/desktop-focus-parser.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/rpc-business-codec.ts', 'packages/core/src/search-metadata.ts',
  'apps/host/src/goals.ts', 'apps/host/src/goal-projection.ts', 'apps/desktop/src/main/desktop-goals.ts',
  'apps/desktop/src/main/spatial-link-ingress.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/desktop-presentation.ts', 'apps/desktop/src/renderer/src/components/InlineObjectLink.tsx',
  'apps/desktop/src/renderer/src/components/GoalDetail.tsx', 'apps/desktop/src/renderer/src/components/GoalPlanGraph.tsx'])
const mutation = process.env.GOAL_LINK_MUTATION ? JSON.parse(process.env.GOAL_LINK_MUTATION) : null
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...current, plugins: [...current.plugins ?? [], { name: 'goal-link-loaded-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!owners.has(path)) return
    const originalSHA256 = sha(source)
    if (mutation?.path === path) for (const edit of mutation.edits) {
      if (source.split(edit.anchor).length !== 2) throw Error('Goal link mutation requires one exact owner segment')
      source = source.replace(edit.anchor, () => edit.replacement)
    }
    const loaded = process.env.GOAL_LINK_LOADED
    if (!loaded) return source
    const row = { path, originalSHA256, loadedSHA256: sha(source), ...(mutation?.path === path ? { mutant: mutation.id } : {}) }
    return `import {appendFileSync as __goalLinkLoaded} from 'node:fs';__goalLinkLoaded(${JSON.stringify(loaded)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...current.test, include: ['apps/desktop/test/goal-address-contract.test.ts', 'apps/desktop/test/desktop-focus-navigation.test.tsx'],
  maxWorkers: 1, fileParallelism: false, passWithNoTests: false } }
