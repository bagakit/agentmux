import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../vitest.config'
const root = resolve(import.meta.dirname, '../../..')
const edits: Record<string, [string, string, string]> = {
  order: ['packages/core/src/agent-semantic-state.ts', 'status.evidenceRevision > activity.evidenceRevision', 'false'],
  'semantic-stamp': ['packages/core/src/client.ts', 'const mainSemantic = updatesSemanticStatus && normalized.mainSubject && !normalized.childActivity', 'const mainSemantic = false'],
  'child-stamp': ['packages/core/src/client.ts', 'const mainSemantic = updatesSemanticStatus && normalized.mainSubject && !normalized.childActivity', 'const mainSemantic = updatesSemanticStatus && normalized.mainSubject || normalized.childActivity === true'],
  'native-stamp': ['packages/core/src/client.ts', 'evidenceRevision: nativeActivity ? revision : next.recoveryActivity.evidenceRevision ?? 1', 'evidenceRevision: next.recoveryActivity.evidenceRevision ?? 1'],
  'cas-phase': ['packages/core/src/client.ts', 'hookEventUpdatesSemanticStatus(phaseFor(current), normalized.lifecycleEvent, providerCanReopen)', 'hookEventUpdatesSemanticStatus(turnPhase, normalized.lifecycleEvent, providerCanReopen)'],
  'durable-phase': ['packages/core/src/client.ts', "if (retainedEnd || agentTurnEndEvidence(current) ||", "if (false || agentTurnEndEvidence(current) ||"],
  'transcript-stamp': ['packages/core/src/client.ts', '}, revision)\n              status.currentActivityRevision = revision', '})\n              status.currentActivityRevision = revision'],
  'read-stamp': ['packages/core/src/client.ts', '...(projected.semanticStatus.evidenceRevision === undefined ? {} : { evidenceRevision: projected.semanticStatus.evidenceRevision })', '...{}'],
  'main-projection': ['packages/core/src/client.ts', 'projected.mainSessionActivity = original.state', 'projected.mainSessionActivity = undefined; /* mutation */ const ignored = original.state']
}
export default defineConfig({ ...base, root, plugins: [{ name: 'main-activity-authority-mutation', enforce: 'pre', transform(source, id) {
  const mutation = process.env.AGENTMUX_MAIN_ACTIVITY_MUTATION
  if (!mutation) return
  const edit = edits[mutation]
  if (!edit) throw new Error('Unknown main activity mutation')
  const path = relative(root, id.split('?')[0]!)
  if (path !== edit[0]) return
  if (source.split(edit[1]).length !== 2) throw new Error('The production mutation must match exactly once')
  const loaded = source.replace(edit[1], edit[2])
  const receipt = process.env.AGENTMUX_MAIN_ACTIVITY_MUTATION_RECEIPT
  if (!receipt) throw new Error('Missing main activity mutation receipt')
  appendFileSync(receipt, JSON.stringify({ mutation, path, original: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(loaded).digest('hex') }) + '\n')
  return { code: loaded, map: null }
} }], test: { ...base.test, include: ['packages/core/test/main-activity-authority.test.ts'], maxWorkers: 1, fileParallelism: false, testTimeout: 30_000, hookTimeout: 15_000, passWithNoTests: false } })
