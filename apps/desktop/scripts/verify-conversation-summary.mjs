import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidenceRoot = join(root, '.bagakit/feature-tracker/plans/ui-process-status-summary/conversation')
const observation = 'packages/client-ui/src/components/NativeProcessObservation.tsx'
const workflow = 'packages/client-ui/src/components/WorkflowObservation.tsx'
const styles = 'packages/client-ui/src/styles/conversation-native-thread.css'
const config = 'apps/desktop/test/vitest.conversation-summary.config.mts'
const tests = ['apps/desktop/test/conversation-summary.test.tsx', 'packages/client-ui/test/conversation-process-detail.test.tsx']
await mkdir(evidenceRoot, { recursive: true })
await verifyRendererSourceMutations({ name: 'conversation-summary', evidenceRoot, owningConfig: config, tests, sources: [observation, workflow, styles], mutations: [
  { label: 'fold-hides-recorded-failure', file: observation, before: 'notice={failureCount > 0', after: 'notice={false && failureCount > 0' },
  { label: 'non-primary-contribution-omitted', file: observation, before: '(record.deferred?.records ?? record.records ?? [record]).some(recordedFailure)', after: '[record].some(recordedFailure)' },
  { label: 'captured-failure-omitted', file: observation, before: "if (original.kind === 'captured') return original.item.status === 'failed'", after: "if (original.kind === 'captured') return false" },
  { label: 'result-presence-guesses-failure', file: observation, before: "part.kind === 'tool-result' && part.failed === true", after: "part.kind === 'tool-result' && part.failed !== true" },
  { label: 'interruption-drawn-as-stop', file: workflow, before: "status === 'interrupted' ? <span className=\"wf-chip\"><WorkflowStatusGlyph status=\"interrupted\" recorded />Interrupted</span>", after: "status === 'interrupted' ? <span className=\"wf-chip\"><WorkflowStatusGlyph status=\"killed\" recorded />Interrupted</span>" }
] })
const consumers = [
  ['apps/desktop/src/renderer/src/components/ActivityView.tsx', '<ConversationView'],
  ['apps/mobile/src/conversation/MobileConversationSurface.tsx', '<ConversationView'],
  ['packages/client-ui/src/components/ConversationView.tsx', '<ConversationRecordSequence'],
  ['apps/desktop/src/renderer/src/components/ActivityView.tsx', '<NativeProcessObservation'],
  ['apps/mobile/src/conversation/MobileConversationSurface.tsx', '<NativeProcessObservation']
]
for (const [file, invocation] of consumers) assert.ok((await readFile(join(root, file), 'utf8')).includes(invocation), `Actual product invocation ${file}: ${invocation}`)
const inputs = [...new Set([observation, workflow, styles, config, ...tests, ...consumers.map(([file]) => file)])]
const sources = Object.fromEntries(await Promise.all(inputs.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
await writeFile(join(evidenceRoot, 'qualification.json'), JSON.stringify({ passed: true, sources, consumers,
  mutationReceipt: join(evidenceRoot, 'conversation-summary/receipt.json'), scope: 'Shared actual Activity/Conversation reader, full and deferred native/captured failure flags, original nodes/detail/Copy and static historical status. No Runtime or protocol change.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, qualification: join(evidenceRoot, 'qualification.json') }))
