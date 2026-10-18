import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
const mutation = process.env.AGENTMUX_INPUTS_MUTATION
const mutations: Record<string, { file: string; from: string; to: string }> = {
  'drop-wire-input-key': { file: 'session-user-messages.ts', from: "item.source === 'user' && item.publicContent === 'confirmed' && item.inputRef", to: 'false' },
  'ignore-native-ambiguity': { file: 'session-inputs.ts', from: '!adoption.ambiguous.has(key) && candidates.length === 1 && candidates[0]!.key', to: 'candidates[0]!.key' },
  'route-host-as-source': { file: 'session-inputs.ts', from: 'const { hostId, sourceHostId, agentSessionId, messages } = input', to: 'const { hostId, agentSessionId, messages } = input; const sourceHostId = input.sourceHostId ?? hostId' },
  'ignore-record-version': { file: 'session-inputs.ts', from: 'if (current && current.revision !== record.revision) return undefined', to: 'if (false) return undefined' },
  'author-object-order': { file: 'session-inputs.ts', from: 'conversationValuesEqual(author, known)', to: 'JSON.stringify(author) === JSON.stringify(known)' },
  'drop-journal-author': { file: 'session-inputs.ts', from: 'value.authors.push(sessionInputMailboxAuthor(item))', to: 'value.authors.push({ kind: "unknown" })' },
  'reject-foreign-relation-body': { file: 'session-history-read-codec.ts', from: 'if (!sameOriginal(parseConversationProvenance(original), original)) return bad()', to: "if (original.sameEvent && (original.sameEvent as { hostId: string }).hostId !== page.sourceHostId || !sameOriginal(parseConversationProvenance(original), original)) return bad()" },
  'ignore-input-kind': { file: 'conversation-stream.ts', from: '[hostId, key.kind, key.agentSessionId, key.expectedRun.runId, agentPromptInputId(key)]', to: '[hostId, key.agentSessionId, key.expectedRun.runId, agentPromptInputId(key)]' }
}
if (mutation && !mutations[mutation]) throw Error('Unknown Inputs source mutation: ' + mutation)
export default defineConfig({ plugins: mutation ? [{ name: 'inputs-source-mutation', enforce: 'pre', transform(code, id) {
  const change = mutations[mutation]!
  if (!id.endsWith('/packages/core/src/' + change.file)) return
  if (!code.includes(change.from)) throw Error('Inputs mutation no longer reaches its exact source branch')
  if (!process.env.AGENTMUX_INPUTS_MUTATION_LOADED) throw Error('Missing mutation load receipt path')
  writeFileSync(process.env.AGENTMUX_INPUTS_MUTATION_LOADED, JSON.stringify({ mutation, file: id, applied: true }) + '\n')
  return code.replace(change.from, change.to)
} }] : [], test: {
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  include: ['packages/core/test/session-inputs.test.ts'],
  setupFiles: [fileURLToPath(new URL('../../../vitest.setup.ts', import.meta.url))],
  maxWorkers: 1
} })
