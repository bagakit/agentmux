import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './workbench-window-presentations.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const stable = 'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx'
const changes = {
  sameValueNoCommit: { file: stable, before: 'setWindowPlacement({ placement, revision: ++placementRevision.current })',
    after: 'setWindowPlacement(previous => previous.placement === placement ? previous : { placement, revision: ++placementRevision.current })', count: 1 },
  desiredOnlyAck: { file: stable, before: 'placementWaiters.current.push({ placement, resolve, reject })',
    after: 'if (placement === windowPlacement) { resolve(); return }; placementWaiters.current.push({ placement, resolve, reject })', count: 1 },
  confirmAll: { file: stable, before: 'if (waiter.placement?.destination === windowPlacement?.destination &&',
    after: 'if (true || waiter.placement?.destination === windowPlacement?.destination &&', count: 1 },
  staleCommit: { file: stable, before: 'placementRequest.revision !== placementRevision.current', after: 'false', count: 2 },
  lateRollback: { file: 'apps/desktop/src/renderer/src/lib/workbench-window-registry.ts', before: 'if (placementRequests.get(key) === request) {\n      if (previous)',
    after: 'if (true) {\n      if (previous)', count: 1 }
} as const
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...owning, plugins: [...(owning.plugins ?? []), {
  name: 'actual-workbench-placement-mutants', enforce: 'pre', transform(source, id) {
    const name = process.env.WORKBENCH_PLACEMENT_MUTATION as keyof typeof changes | undefined
    if (!name) return
    const change = changes[name]; assert.ok(change)
    if (relative(root, id) !== change.file) return
    const occurrences = source.split(change.before).length - 1
    assert.equal(occurrences, change.count, 'The declared mutation must hit the exact actual placement owner')
    const changed = source.replaceAll(change.before, change.after)
    if (process.env.WORKBENCH_PLACEMENT_HITS) appendFileSync(process.env.WORKBENCH_PLACEMENT_HITS,
      JSON.stringify({ name, file: change.file, occurrences, source: sha(source), changed: sha(changed) }) + '\n')
    return { code: changed, map: null }
  }
}], test: { ...owning.test, include: process.env.WORKBENCH_PLACEMENT_MUTATION ? ['test/workbench-placement-confirmation.test.tsx'] : owning.test.include,
  passWithNoTests: false, maxWorkers: 1 } })
