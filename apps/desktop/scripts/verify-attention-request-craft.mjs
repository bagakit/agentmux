import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

// The Attention panel answers the same Core request as the Session card: the same Run boundary
// decides answerability, and opening the panel lands keyboard focus inside the request.
const root = resolve(import.meta.dirname, '../../..')
const panel = 'apps/desktop/src/renderer/src/components/AttentionRequestPanel.tsx'
const config = 'apps/desktop/test/attention-request-craft-consumers.config.mts'
const tests = ['apps/desktop/test/attention-request-craft.test.tsx']
const mutations = [
  { label: 'earlier-run-request-stays-answerable', file: panel, before: '        Boolean(request.evidence.run && request.evidence.run.runId !== runIdFor(session))}', after: '        false}' },
  { label: 'first-focus-lands-on-grant', file: panel, before: "panel.querySelector<HTMLElement>('.agent-interaction__dismiss:not([disabled])')", after: "panel.querySelector<HTMLElement>('.agent-interaction button:not([disabled])')" }
]
const sources = [panel, 'packages/client-ui/src/components/AgentInteractionCard.tsx', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/test/vitest.ui-controls-owning.config.mts', 'packages/capsule/package.json',
  // Keep shared preview fixture inputs in the isolated source copy.
  'test/fixture-values.mjs', 'test/fixture-epoch.cjs']
const evidence = process.env.AGENTMUX_EVIDENCE_ROOT ?? join(root, '.tmp/attention-request-craft')
const name = 'mutations-' + randomUUID()
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, owningConfig: config, tests, sources, mutations })
const proof = JSON.parse(await readFile(join(evidence, name, 'receipt.json'), 'utf8'))
assert.equal(proof.passed, true); assert.equal(proof.cases.length, mutations.length)
console.log(JSON.stringify({ passed: true, mutants: mutations.length, receipt: join(evidence, name, 'receipt.json') }))
