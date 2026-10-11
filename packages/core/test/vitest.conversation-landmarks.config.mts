import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  routeContext: ['packages/core/src/conversation-landmarks.ts', 'hostId: point.routeHostId ?? point.reference.hostId', 'hostId: point.reference.hostId'],
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
  const file = relative(root, id.split('?')[0]!)
  let code = source
  if (name) {
    assert.ok(mutations[name]); const [target, needle, replacement] = mutations[name]
    if (file === target) {
      assert.equal(source.split(needle).length - 1, 1)
      if (process.env.LANDMARK_HITS) appendFileSync(process.env.LANDMARK_HITS, file + '\n')
      code = source.replace(needle, replacement)
    }
  }
  if (process.env.LANDMARK_LOADED && file.startsWith('packages/core/src/') && file.endsWith('.ts')) appendFileSync(process.env.LANDMARK_LOADED,
    JSON.stringify({ path: file, originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
  if (code !== source) return { code, map: null }
} }], test: { include: ['packages/core/test/conversation-landmarks.test.ts'], passWithNoTests: false, testTimeout: 30000, hookTimeout: 60000 } })
