import { defineConfig } from 'vitest/config'
import original from './vitest.goal-cross-host.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const variants: Record<string, [string, string, string]> = {
  events: ['packages/core/src/public-rpc-service.ts', 'for (const event of exported.dispatchEvents ?? []) if (event.provenance.target.runtimeId === authority.source.runtimeId)', "for (const event of [] as import('./agent-message-federation.js').AgentMuxSignedDispatchEvent[]) if (event.provenance.target.runtimeId === authority.source.runtimeId)"],
  answers: ['packages/core/src/public-rpc-service.ts', 'const outbox = await owner.client.readFederatedOutbox({ sourceMessageId, ...auth })', "const outbox = { messages: [] as import('./agent-message-federation.js').AgentMuxSignedMessage[], dispatchEvents: [] as import('./agent-message-federation.js').AgentMuxSignedDispatchEvent[] }"],
  signature: ['packages/core/src/agent-creation-authority.ts', "if (bytes.toString('base64url') !== signature || !verify(null, Buffer.from(JSON.stringify(payload)), publicKey(trust.publicKey).key, bytes)) failure('The original message source signature is invalid.'", "if (false) failure('The original message source signature is invalid.'"]
}
export default defineConfig({ ...original, plugins: [...(original.plugins ?? []), {
  name: 'original-dialogue-owner-mutation', enforce: 'pre', transform(source, id) {
    const variant = process.env.AGENTMUX_TEST_DIALOGUE_MUTATION
    if (!variant) return
    const change = variants[variant]
    if (!change) throw new Error('Unknown original dialogue mutation')
    if (!id.split('?')[0]!.endsWith('/' + change[0])) return
    if (source.split(change[1]).length !== 2) throw new Error('Original dialogue mutation anchor must be unique')
    const changed = source.replace(change[1], change[2])
    if (process.env.AGENTMUX_TEST_DIALOGUE_LOADED) appendFileSync(process.env.AGENTMUX_TEST_DIALOGUE_LOADED, JSON.stringify({
      file: change[0], sourceSHA: createHash('sha256').update(source).digest('hex'), loadedSHA: createHash('sha256').update(changed).digest('hex'), transformed: true }) + '\n')
    return { code: changed, map: null }
  }
}], test: { ...original.test, include: ['apps/host/test/goal-cross-host-dialogue.test.ts'], passWithNoTests: false, testTimeout: 75_000 } })
