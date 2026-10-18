import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const mutation = process.env.AGENTMUX_SOURCE_ROLES_MUTATION
const mutations: Record<string, [string, string, string]> = {
  'snapshot-as-speech': ['CapturedConversationMessage.tsx', "observation={record?.role === 'observation' || Boolean(replyObservation)}", 'observation={false}'],
  'fragment-process': ['conversation-record-sequence.ts', "if (record.role === 'process') {", "if (record.role === 'process') { flush()"],
  'lose-internal-slot': ['conversation-record-sequence.ts', 'insert(key)', 'if (!process.length) insert(key)'],
  'forget-selected-parent': ['use-conversation-record-layout.ts', 'prior.parent === next.parent', 'true'],
  'tail-after-captured': ['NativeProcessObservation.tsx', '{layout.map(entry => {', "{[...layout.filter(entry => entry.kind !== 'anchor'), ...layout.filter(entry => entry.kind === 'anchor')].map(entry => {"]
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-source-roles', plugins: [{ name: 'source-role-counterexamples', enforce: 'pre', transform(source, id) {
  const file = id.split('?')[0]!
  if (!/\/(ActivityView|ConversationView|CapturedConversationMessage|ConversationRecordSequence|NativeProcessObservation|WorkflowObservation|conversation-record-sequence|use-conversation-record-layout)\.(tsx|ts)$/u.test(file)) return
  const replacement = mutation ? mutations[mutation] : undefined
  if (mutation && !replacement) throw Error('Unknown source-role mutation: ' + mutation)
  let code = source
  if (replacement && file.endsWith('/' + replacement[0])) {
    if (source.split(replacement[1]).length !== 2) throw Error('Non-unique source-role mutation: ' + mutation)
    code = source.replace(replacement[1], replacement[2])
  }
  const log = process.env.AGENTMUX_SOURCE_ROLES_LOADED
  if (log) appendFileSync(log, JSON.stringify({ path: relative(process.cwd(), file), originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), ...(source === code ? {} : { mutation }) }) + '\n')
  return source === code ? undefined : { code, map: null }
} }, ...base.plugins!], test: { ...base.test,
  include: ['apps/desktop/test/conversation-source-roles.test.tsx', 'apps/desktop/test/conversation-chronological-reading.test.tsx', 'apps/desktop/test/native-process-reading.test.tsx'] } })
