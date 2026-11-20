import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
const mutations: Record<string, [string, string, string]> = {
  signature: ['agent-creation-authority.ts', "if (bytes.toString('base64url') !== signature || !verify(null, Buffer.from(JSON.stringify(payload)), publicKey(trust.publicKey).key, bytes)) failure('The original message source signature is invalid.'", "if (false) failure('The original message source signature is invalid.'"],
  digest: ['agent-message-federation.ts', "messagePacketDigest({ envelope, execution: 'default', sourceChannel }) !== provenance.intentDigest", 'false'],
  'single-approved-packet': ['agent-message-federation.ts', 'if (input.packetDigest !== candidate.packetDigest) throw new AgentMuxError(', 'if (false) throw new AgentMuxError('],
  'single-approving-actor': ['public-rpc-service.ts', "case 'message.federation.approve': {\n        if (context.caller !== undefined || context.routeDelegation !== undefined || !context.principal ||", "case 'message.federation.approve': {\n        if (context.routeDelegation !== undefined || !context.principal ||"],
  'single-source-signature': ['agent-creation-authority.ts', "if (proof.sourceKeyFingerprint !== source.fingerprint || bytes.toString('base64url') !== signature || !verify(null, Buffer.from(JSON.stringify(payload)), source.key, bytes)) failure(", "if (proof.sourceKeyFingerprint !== source.fingerprint) failure("],
  'single-durable-inbox': ['agent-global-message-queue.ts', 'await this.appendRecord(record)\n      if (newMessage?.inputEnvironment !== undefined', "if (newMessage?.deliveryMode !== 'reference') await this.appendRecord(record)\n      if (newMessage?.inputEnvironment !== undefined"],
  'single-auto-notify': ['agent-global-message-queue.ts', "if (!record.inboxOnly) this.db.prepare('INSERT INTO a2a_message_notifications", "this.db.prepare('INSERT INTO a2a_message_notifications"],
  'single-explicit-notify': ['agent-global-message-queue.ts', 'if (original?.inbox_only === 1) throw new AgentMuxError(', 'if (false) throw new AgentMuxError('],
  'inbox-signature': ['agent-creation-authority.ts', "if (key.fingerprint !== receipt.keyFingerprint || bytes.toString('base64url') !== signature ||\n    !verify(null, Buffer.from(JSON.stringify(payload)), key.key, bytes))", 'if (false)']
}
export default defineConfig({
  root: resolve(import.meta.dirname, '../../..'),
  plugins: [{ name: 'message-authority-proof', enforce: 'pre', transform(source, id) {
    const variant = process.env.AGENTMUX_TEST_MESSAGE_MUTATION
    if (!variant) return
    const mutation = mutations[variant]
    if (!mutation) throw new Error('Unknown message authority mutation')
    if (!id.split('?')[0]!.endsWith('/src/' + mutation[0])) return
    if (source.split(mutation[1]).length !== 2) throw new Error('Message authority mutation anchor is not unique')
    const changed = source.replace(mutation[1], mutation[2]), report = process.env.AGENTMUX_TEST_MESSAGE_LOADED
    const receipt = { file: 'packages/core/src/' + mutation[0], mutation: variant, sourceSHA: createHash('sha256').update(source).digest('hex'), loadedSHA: createHash('sha256').update(changed).digest('hex'), transformed: true }
    const header = report ? "import {appendFileSync as __messageAuthorityLoaded} from 'node:fs'; __messageAuthorityLoaded(" + JSON.stringify(report) + ',' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' : ''
    return { code: header + changed, map: null }
  } }],
  test: { include: process.env.AGENTMUX_TEST_MESSAGE_ROUTE_ONLY === '1' ? ['packages/core/test/a2a-route-identity.test.ts'] : ['packages/core/test/agent-message-authority.test.ts', 'packages/core/test/agent-message-authorization.test.ts', 'packages/core/test/agent-creation-authority.test.ts'], maxWorkers: 1, passWithNoTests: false }
})
