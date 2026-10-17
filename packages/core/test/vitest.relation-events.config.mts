import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.a2a-collaboration.config.mts'

export const relationMutations = [
  { name: 'latest-related-selection', file: 'packages/core/src/agent-global-message-queue.ts',
    before: "ORDER BY event_sequence ${backward ? 'DESC' : 'ASC'} LIMIT ?)", after: 'ORDER BY event_sequence ASC LIMIT ?)' },
  { name: 'older-exclusive-position', file: 'packages/core/src/agent-global-message-queue.ts',
    before: "const before = input.beforeSequence === undefined ? '' : ' AND event_sequence<?'",
    after: "const before = input.beforeSequence === undefined ? '' : ' AND event_sequence<=?'" },
  { name: 'independent-older-cursor', file: 'packages/core/src/agent-global-message-queue.ts',
    before: 'nextBeforeSequence: backward && rows.length > limit ? events[0]!.sequence : null',
    after: 'nextBeforeSequence: backward && rows.length > limit ? events.at(-1)!.sequence : null' },
  { name: 'exact-query-direction', file: 'packages/core/src/agent-message-events.ts',
    before: 'page.latest !== (input.latest ?? false)', after: 'false' },
  { name: 'public-latest-forwarding', file: 'packages/core/src/public-rpc-service.ts',
    before: 'const { hostId: _hostId, ...query } = p', after: 'const { hostId: _hostId, latest: _lost, ...query } = p' },
  { name: 'related-index-cost', file: 'packages/core/src/agent-global-message-queue.ts',
    before: 'WHERE participant_id=? AND event_sequence>? AND event_sequence<=?${before}${scope}',
    after: 'WHERE substr(participant_id,1)=? AND event_sequence>? AND event_sequence<=?${before}${scope}' },
  { name: 'metadata-without-body-decode', file: 'packages/core/src/agent-global-message-queue.ts',
    before: 'const selected = rows.slice(0, limit)',
    after: "const selected = rows.slice(0, limit); for (const row of selected) JSON.parse(String(this.db.prepare('SELECT json FROM records WHERE sequence=?').get(row.sequence)!.json))" },
  { name: 'cross-process-dispatch-position', file: 'packages/core/src/agent-message-journal.ts',
    before: "WHEN json_extract(NEW.json, '$.kind') IN ('dispatch-open', 'dispatch-event')",
    after: "WHEN 0 AND json_extract(NEW.json, '$.kind') IN ('dispatch-open', 'dispatch-event')" },
  { name: 'hosted-dispatch-consumer', file: 'packages/core/src/hosted-value.ts',
    before: "'delivery-issue', 'dispatch-open', 'dispatch-event', 'a2a-notification'",
    after: "'delivery-issue', 'a2a-notification'" },
  { name: 'event-read-restores-observation', file: 'packages/core/src/client.ts',
    before: 'void this.observeMessageReads()?.refresh()\n    return this.messageQueue.listMessageEvents(query,',
    after: 'void 0\n    return this.messageQueue.listMessageEvents(query,' }
] as const
const root = resolve(import.meta.dirname, '../../..'), name = process.env.AGENTMUX_RELATION_MUTATION
const mutation = relationMutations.find(item => item.name === name)
if (name && !mutation) throw new Error('Unknown relation source mutation: ' + name)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...source, plugins: [...source.plugins ?? [], {
  name: 'relation-events-source-proof', enforce: 'pre', transform(code, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!/^packages\/core\/(?:src|test)\/.*\.ts$/u.test(file)) return
    let input = code
    if (file === mutation?.file) {
      if (code.split(mutation.before).length !== 2) throw new Error('Relation mutation requires its unique source anchor: ' + mutation.name)
      input = code.replace(mutation.before, mutation.after)
    }
    if (process.env.AGENTMUX_RELATION_LOADED) appendFileSync(process.env.AGENTMUX_RELATION_LOADED,
      JSON.stringify({ file, sourceSHA256: digest(code), compilerInputSHA256: digest(input),
        ...(input !== code ? { mutation: mutation!.name } : {}) }) + '\n')
    if (input !== code) return { code: input, map: null }
  }
}], test: { ...source.test,
  include: ['packages/core/test/a2a-relation-events.test.ts', 'packages/core/test/a2a-broadcast-events.test.ts', 'packages/core/test/agent-message-observer.test.ts'],
  testTimeout: 20_000
} })
