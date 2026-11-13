import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const mutations: Record<string, [string, string, string]> = {
  signature: ['agent-creation-authority.ts', "if (bytes.toString('base64url') !== signature || !verify(null, Buffer.from(JSON.stringify(payload)), publicKey(trust.publicKey).key, bytes)) failure('The original message source signature is invalid.'", "if (false) failure('The original message source signature is invalid.'"],
  digest: ['agent-message-federation.ts', "messagePacketDigest({ envelope, execution: 'default', sourceChannel }) !== provenance.intentDigest", 'false']
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
    return { code: source.replace(mutation[1], mutation[2]), map: null }
  } }],
  test: { include: ['packages/core/test/agent-message-authority.test.ts', 'packages/core/test/agent-creation-authority.test.ts'], maxWorkers: 1, passWithNoTests: false }
})
