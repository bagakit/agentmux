import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goal-plan-discovery.config.mts'
const repository = resolve(import.meta.dirname, '../../..')
const mutation = process.env.GOAL_PLAN_REQUEST_MUTANT ? JSON.parse(process.env.GOAL_PLAN_REQUEST_MUTANT) : null
export default { ...original, plugins: [...(original.plugins ?? []), {
  name: 'goal-plan-request-original-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(repository, id.split('?')[0]!)
    if (!mutation || path !== mutation.path) return
    const digest = (value: string) => createHash('sha256').update(value).digest('hex'), originalSHA256 = digest(source)
    for (const edit of mutation.edits ?? [{ anchor: mutation.anchor, replacement: mutation.replacement }]) {
      if (source.split(edit.anchor).length !== 2) throw Error('Planning mutation must name exactly one original owner anchor: ' + mutation.id)
      source = source.replace(edit.anchor, () => edit.replacement)
    }
    const row = { path, mutant: mutation.id, originalSHA256, loadedSHA256: digest(source), consumer: 'public-owner-and-mounted-planning' }
    const output = process.env.GOAL_PLAN_REQUEST_LOADED
    if (!output) return source
    appendFileSync(output, '')
    return `import { appendFileSync as __goalRequestLoaded } from 'node:fs'; __goalRequestLoaded(${JSON.stringify(output)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...original.test, include: [
  'apps/desktop/test/goal-plan-discovery-product.test.tsx', 'apps/desktop/test/goal-plan-graph.test.tsx',
  'apps/host/test/goal-runtime-client-leases.test.ts', 'apps/host/test/goal-supervisor-identity.test.ts',
  'apps/host/test/goal-first-discussion.test.ts', 'apps/host/test/goal-discussion-intent.test.ts', 'apps/host/test/goal-planning-discussion.test.ts',
  'packages/core/test/goal-plan-guidance.test.ts', 'packages/core/test/goal-acknowledgement-rpc.test.ts',
  'apps/mobile/test/mobile-goals.test.tsx', 'apps/mobile/test/mobile-goal-owner.test.tsx'
], environmentMatchGlobs: [['apps/mobile/test/**', 'happy-dom']] as [string, string][], setupFiles: [resolve(repository, 'vitest.setup.ts'), resolve(repository, 'apps/mobile/test/device-locks.ts')],
  maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 60_000, hookTimeout: 60_000 } }
