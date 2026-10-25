import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/plans/ui-detail-polish/process')
const observation = 'packages/client-ui/src/components/NativeProcessObservation.tsx'
const workflow = 'packages/client-ui/src/components/WorkflowObservation.tsx'
const view = 'packages/client-ui/src/components/ConversationView.tsx'
const config = 'apps/desktop/test/vitest.process-detail-density.config.mts'
const tests = ['apps/desktop/test/process-detail-density.test.tsx', 'apps/desktop/test/conversation-summary.test.tsx']
const sources = [observation, workflow, view, 'packages/client-ui/src/components/ConversationMessage.tsx',
  'packages/client-ui/src/components/ConversationMessageCard.tsx', 'packages/client-ui/src/styles/conversation-native-thread.css',
  'apps/desktop/test/vitest.ui-controls-owning.config.mts']
const mutations = [
  { label: 'result-loses-original-name', file: observation, before: "result?.name ? `${result.name} result`", after: "false ? `${result.name} result`" },
  { label: 'process-body-repeats-speech-heading', file: view, before: "processContent={record.role === 'process' && Boolean(wrapBody)", after: "processContent={false && record.role === 'process' && Boolean(wrapBody)" },
  { label: 'history-missing-state-repeats-inline', file: workflow, before: "status === undefined && !missingStatusInDetails", after: "status === undefined" },
  { label: 'source-detail-loses-missing-state', file: observation, before: "status ?? 'Status not recorded'", after: "status ?? ''" },
  { label: 'source-detail-loses-original-session', file: observation, before: '<dt>Native session</dt><dd><code>{source.nativeSessionId}</code>', after: '<dt>Native session</dt><dd><code>{source.providerId}</code>' },
  { label: 'fold-hides-original-failure', file: observation, before: 'notice={failureCount > 0', after: 'notice={false && failureCount > 0' }
]
await mkdir(evidence, { recursive: true })
const name = `mutations-${randomUUID()}`
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, owningConfig: config, tests, sources, mutations })
let mutationReceipt = join(evidence, name, 'receipt.json')
if (process.env.AGENTMUX_MUTATION_RECEIPTS) {
  const receipts = await Promise.all(JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS).map(async path => ({ path, proof: JSON.parse(await readFile(path, 'utf8')) })))
  const matching = receipts.filter(({ proof }) => JSON.stringify(proof.cases.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations))
  assert.equal(matching.length, 1); mutationReceipt = matching[0].path
}
const consumers = ['apps/desktop/src/renderer/src/components/ActivityView.tsx', 'apps/mobile/src/conversation/MobileConversationSurface.tsx',
  'apps/desktop/test/helpers/conversation-static-fixture.tsx']
const files = [...new Set([...sources, config, ...tests, ...consumers])]
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ schema: 'agentmux.process-detail-density-qualification.v1', passed: true, inputs,
  mutationReceipt, mutationCount: mutations.length,
  consumers: 'Actual ActivityView and shared ConversationView via the original pure Core projection with a bounded static source port; public Reader transport is unchanged.',
  protected: ['Original failure contribution summary and interruption', 'Full output, source, Call ID and original Copy', 'Public answer, original record nodes and selection', 'Opaque and deferred native source detail'],
  publicCapability: 'Presentation of existing exact records only; no new public method, configuration, IO or operation.',
  boundary: 'No live Runtime, OS IME, installed app or Session lifecycle claim.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, mutationReceipt, qualification: join(evidence, 'qualification.json') }))
