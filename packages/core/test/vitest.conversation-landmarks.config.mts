import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  causalRevision: ['packages/core/src/conversation-landmarks.ts', 'if (committedRevision !== input.expectedRevision + 1)', 'if (false)'],
  source: ['packages/core/src/conversation-landmarks.ts', "source: { kind: 'native', providerId: text(source.providerId), nativeSessionId: text(source.nativeSessionId), recordId }", "source: { kind: 'captured', recordId }"],
  scope: ['packages/core/src/conversation-landmarks.ts', 'return a.hostId === b.hostId && a.agentSessionId === b.agentSessionId', 'return true'],
  revision: ['packages/core/src/conversation-landmark-store.ts', 'if (original.expectedRevision !== current.revision)', 'if (false)'],
  operation: ['packages/core/src/conversation-landmark-store.ts', '!isDeepStrictEqual(recorded.input, original) || !isDeepStrictEqual(recorded.actor, actor)', 'false'],
  persist: ['packages/core/src/conversation-landmark-store.ts', "await durableWriteFile(this.path, JSON.stringify(next) + '\\n', { requireDirectorySync: true })", ''],
  service: ['packages/core/src/public-rpc-service.ts', 'result = await this.landmarks.apply(parseConversationLandmarkWrite(p), actor); break', 'result = await this.landmarks.list(parseConversationLandmarkQuery({ hostId: p.hostId, agentSessionId: p.agentSessionId })); break'],
  receipt: ['packages/core/src/conversation-landmarks.ts', '!page.recordedOperation || JSON.stringify(page.recordedOperation.input) !== JSON.stringify(expected)', 'false']
} as const
export default defineConfig({ plugins: [{ name: 'conversation-landmark-mutations', enforce: 'pre', transform(source, id) {
  const name = process.env.LANDMARK_MUTATION as keyof typeof mutations | undefined
  if (!name) return
  assert.ok(mutations[name]); const [file, needle, replacement] = mutations[name]
  if (relative(root, id) !== file) return
  assert.equal(source.split(needle).length - 1, 1)
  if (process.env.LANDMARK_HITS) appendFileSync(process.env.LANDMARK_HITS, file + '\n')
  return { code: source.replace(needle, replacement), map: null }
} }], test: { include: ['packages/core/test/conversation-landmarks.test.ts'], passWithNoTests: false, testTimeout: 30000, hookTimeout: 60000 } })
