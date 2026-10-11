import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'

const mutation = process.env.AGENTMUX_TIMELINE_MUTATION
const mutations: Record<string, [string, string, string]> = {
  'snapshot-as-message': ['conversation-timeline.ts', "return 'observation'", "return 'message'"],
  'ignore-human-author': ['conversation-author.ts', "if (item.authorHuman === true)", "if (false && item.authorHuman === true)"],
  'drop-mixed-part': ['conversation-timeline.ts', 'original.item.contentParts.map((_, partIndex)', 'original.item.contentParts.slice(1).map((_, partIndex)'],
  'invent-body-join': ['conversation-timeline.ts', 'const target = provenance?.sameEvent', "const target = provenance?.sameEvent ?? (record.original.kind === 'captured' ? native[0]?.reference ?? undefined : undefined)"],
  'merge-invocation-parent': ['conversation-timeline.ts', 'const anchor = (record: ConversationSourceRecord): string => resolved.anchors.get(record.id)!', "const anchor = (record: ConversationSourceRecord): string => { const member = conversationInvocationMembers(record)[0]; return member ? records.find(peer => conversationInvocationMembers(peer).some(value => conversationInvocationId(value.invocation) === conversationInvocationId(member.invocation)))!.id : resolved.anchors.get(record.id)! }"],
  'hide-unread-anchor': ['conversation.ts', 'timeline.events.map(event => {', 'timeline.events.filter(event => records.has(event.anchorId)).map(event => {']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-timeline', plugins: [{ name: 'timeline-owned-counterexamples', enforce: 'pre', transform(source, id) {
  const file = id.split('?')[0]!
  if (!/\/(conversation(?:-timeline|-author|-provenance)?|session-user-messages|FocusMessagePreview|conversation-records|conversation-speaker)\.(tsx|ts)$/u.test(file)) return
  let code = source
  const replacement = mutation ? mutations[mutation] : undefined
  if (replacement && file.endsWith('/' + replacement[0])) {
    if (source.split(replacement[1]).length !== 2) throw Error('Non-unique or unloaded timeline mutation: ' + mutation)
    code = source.replace(replacement[1], replacement[2])
  }
  const log = process.env.AGENTMUX_TIMELINE_LOADED
  if (log) appendFileSync(log, JSON.stringify({ path: relative(process.cwd(), file), originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), ...(code === source ? {} : { mutation }) }) + '\n')
  return source === code ? undefined : { code, map: null }
} }, ...base.plugins!], test: { ...base.test, include: ['packages/core/test/conversation-timeline.test.ts', 'apps/desktop/test/focus-conversation-timeline.test.tsx'] } })
