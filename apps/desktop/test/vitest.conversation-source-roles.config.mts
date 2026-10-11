import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const mutation = process.env.AGENTMUX_SOURCE_ROLES_MUTATION
const mutations: Record<string, [string, string, string]> = {
  'snapshot-as-speech': ['ActivityView.tsx', "return item.source === 'native-hook' && item.kind === 'assistant_message'", "return false && item.source === 'native-hook' && item.kind === 'assistant_message'"],
  'fragment-process': ['conversation-record-sequence.ts', "if (insertion.role === 'process') append({ kind: 'insertion', insertion })", "if (insertion.role === 'process') { flush(); append({ kind: 'insertion', insertion }); flush() }"],
  'lose-internal-slot': ['conversation-record-sequence.ts', 'insert(item.id)', "if (!process.length || (insertBefore.get(item.id) ?? []).some(entry => entry.role !== 'process')) insert(item.id)"],
  'forget-captured-parent': ['ConversationRecordSequence.tsx', 'for (const [key, group] of previousInsertions) if (projection.insertionGroups.has(key)', 'for (const [key, group] of previousInsertions) if (false && projection.insertionGroups.has(key)'],
  'tail-after-captured': ['NativeProcessObservation.tsx', "{layout.map(entry => entry.kind", "{[...layout.filter(entry => entry.kind !== 'insertion' || entry.role !== 'anchor'), ...layout.filter(entry => entry.kind === 'insertion' && entry.role === 'anchor')].map(entry => entry.kind"]
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-source-roles', plugins: [{ name: 'source-role-counterexamples', enforce: 'pre', transform(source, id) {
  const file = id.split('?')[0]!
  if (!/\/(ActivityView|CapturedConversationMessage|ConversationRecordSequence|NativeProcessObservation|WorkflowObservation|conversation-record-sequence)\.(tsx|ts)$/u.test(file)) return
  const replacement = mutation ? mutations[mutation] : undefined
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
