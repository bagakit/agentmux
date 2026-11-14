import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/components/GoalSupervisorRail.tsx'
const mutation = process.env.GOAL_SUPERVISOR_RAIL_MUTATION
if (mutation && mutation !== 'loose-attempt') throw new Error('Unknown Supervisor rail mutation')
export default defineConfig({ root, esbuild: { jsx: 'automatic' }, resolve: { alias: [
  { find: '@agentmux/demand/relations', replacement: resolve(root, 'packages/demand/src/relations.ts') },
  { find: '@agentmux/client-ui/display-name', replacement: resolve(root, 'packages/client-ui/src/lib/display-name.ts') },
  { find: '@agentmux/client-ui/icons', replacement: resolve(root, 'packages/client-ui/src/theme/icons.tsx') },
  ...['react', 'react-dom'].map(find => ({ find, replacement: resolve(root, 'apps/desktop/node_modules', find) }))
] }, plugins: [{ name: 'actual-goal-supervisor-rail', enforce: 'pre', transform(source, id) {
  if (relative(root, id.split('?')[0]!) !== owner) return
  const originalSHA256 = createHash('sha256').update(source).digest('hex')
  if (mutation) {
    const anchor = 'return node && delegation?.planNodeId === node.id ?'
    if (source.split(anchor).length !== 2) throw new Error('The Supervisor rail mutation requires one actual owner anchor')
    source = source.replace(anchor, 'return node ?')
  }
  const receipt = process.env.GOAL_SUPERVISOR_RAIL_LOADED
  if (!receipt) return source
  const row = { owner, mutation: mutation ?? null, originalSHA256, loadedSHA256: createHash('sha256').update(source).digest('hex'), boundary: 'Mounted original rail; original identity renderer and workbench visibility are explicit test leaves.' }
  appendFileSync(receipt, JSON.stringify({ ...row, phase: 'transformed' }) + '\n')
  return `import {appendFileSync as __railLoaded} from 'node:fs';__railLoaded(${JSON.stringify(receipt)},${JSON.stringify(JSON.stringify({ ...row, phase: 'executed' }) + '\n')});\n` + source
} }], test: { include: ['apps/desktop/test/goal-supervisor-rail.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
