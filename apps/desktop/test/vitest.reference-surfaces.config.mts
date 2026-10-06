import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const coreAliases = Object.entries(exports).map(([key, value]) => ({ find: key === '.' ? '@agentmux/core' : `@agentmux/core/${key.slice(2)}`,
  replacement: resolve(root, 'packages/core', (value as { import: string }).import.replace('/dist/', '/src/').replace(/\.js$/, '.ts')) })).sort((a,b) => b.find.length-a.find.length)
const activity = 'apps/desktop/src/renderer/src/components/GoalActivity.tsx'
const changes = {
  rationale: [activity, "entry.decision.rationale || 'Not recorded'", "entry.decision.question || 'Not recorded'"],
  actor: [activity, "entry.decision.actorId || 'Unknown'", "'Current Agent'"],
  activity: [activity, 'decision: undefined', 'decision: demand.decisions?.[0]'],
  goal: [activity, 'key={demand.id}', 'key="shared"'],
  reading: [activity, 'key={entry.key}', 'key={`${entry.key}:${entry.text}`}'],
  consumer: ['apps/desktop/src/renderer/src/components/GoalDetail.tsx', '<GoalActivity demand={demand} />', '{null}']
} as const
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { conditions: ['browser'], alias: coreAliases },
  plugins: [{ name: 'actual-reference-surface-mutation', enforce: 'pre', transform(source,id) {
    const mutation = process.env.REFERENCE_SURFACE_MUTATION as keyof typeof changes | undefined
    if (!mutation) return
    assert.ok(changes[mutation], 'Known mutation'); const [path,needle,value] = changes[mutation]
    if (relative(root,id) !== path) return
    assert.equal(source.split(needle).length-1,1, 'Unique original implementation mutation')
    if (process.env.REFERENCE_SURFACE_MUTATION_HITS) appendFileSync(process.env.REFERENCE_SURFACE_MUTATION_HITS,path+'\n')
    return { code: source.replace(needle,value), map: null }
  } }], test: { include: ['apps/desktop/test/demand-timeline.test.tsx'], setupFiles: [resolve(root,'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
