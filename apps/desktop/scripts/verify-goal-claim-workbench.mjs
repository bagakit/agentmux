import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const rail = 'apps/desktop/src/renderer/src/components/GoalSupervisorRail.tsx'
const evidence = resolve(root, '.tmp/goal-claim-workbench')
execFileSync(process.execPath, [resolve(import.meta.dirname, 'verify-goal-plan-assignment.mjs')], { cwd: root, stdio: 'inherit' })
await verifyRendererSourceMutations({
  name: 'supervisor-source',
  tests: ['apps/desktop/test/goal-supervisor-rail.test.tsx'],
  sources: [rail],
  evidenceRoot: evidence,
  mutations: [{ label: 'diagnostics-displace-summary', file: rail, before: '<p className="goal-supervisor-rail__issue" role="status">{diagnostic}</p>',
    after: '<p className="goal-supervisor-rail__issue" role="status">{observation?.reason}</p>' }]
})
execFileSync(process.execPath, [resolve(import.meta.dirname, 'verify-goals-surface.mjs'), '--goal-claim-workbench-only', '--evidence', evidence],
  { cwd: root, stdio: 'inherit' })
