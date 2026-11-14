import { defineConfig } from 'vitest/config'
import main from './vitest.mote-creator-main.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const variants: Record<string, { path: string; before: string; after: string; also?: { before: string; after: string }[] }> = {
  fence: { path: 'packages/core/src/public-rpc-service.ts', before: 'if (isMoteChatMethod(method)) {', after: 'if (isMoteChatMethod(method)) {', also: [{ before: '      await this.assertRuntimeFence(context)\n      if (!owner)', after: '      if (!owner)' }, { before: 'await context.assertCurrent?.(); await this.assertRuntimeFence(context); if (caller)', after: 'await context.assertCurrent?.(); if (caller)' }] },
  recipient: { path: 'packages/connectors/src/mote-chat.ts', before: 'this.assertReplyCaller(source, context, true)', after: 'void 0' },
  delivered: { path: 'packages/connectors/src/mote-chat.ts', before: 'this.replyProof(source, delivery.inputReceipt)\n    const proof = { key: delivery.inputReceipt!.key, status: delivery.inputReceipt!.status }',
    after: "const proof = { key: { kind: 'message' as const, agentSessionId: source.input.agentSessionId, expectedRun: source.input.expectedRun, messageId: source.input.messageId }, status: 'terminal-confirmed' as const }" },
  hint: { path: 'packages/core/src/agent-message-input.ts', before: "moteReply?.route === 'unconfirmed'", after: 'false' },
  consumer: { path: 'packages/connectors/src/connection-services.ts', before: 'publication: () => publication', after: 'publication: () => undefined' },
  dto: { path: 'packages/core/src/mote-chat-codec.ts', before: 'const binding = o.binding, source = delivery.reference.source', after: 'return true\n  const binding = o.binding, source = delivery.reference.source' },
  'unknown-dispatch': { path: 'packages/connectors/src/publication-host.ts', before: 'adapter.inspect!(parsePreparedPublication(retained.prepared, adapter), retained.target, credential, signal, retained.mapping)', after: 'adapter.dispatch(parsePreparedPublication(retained.prepared, adapter), retained.target, credential, signal, retained.mapping)' },
  notice: { path: 'packages/connectors/src/publication-host.ts', before: "if (source.kind === 'mote-chat-reply') {\n      const original", after: "if (source.kind === 'mote-chat-reply') {\n      return this.noticeTarget(notice)\n      const original" }
}
const mutant = process.env.MOTE_CREATOR_REPLY_MUTANT, change = mutant ? variants[mutant] : undefined
if (mutant && !change) throw Error('Unknown original reply mutation')
export default defineConfig({ ...main, cacheDir: '.local/state/mote-link-chat-review/reply-cache-' + (mutant ?? 'original'),
  plugins: [{ name: 'mote-reply-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(main.root!, id.split('?')[0]!)
    if (!/^(apps\/host\/src|packages\/(core|connectors)\/src)\//u.test(path)) return
    let loaded = code
    if (path === change?.path) {
      if (code.split(change.before).length !== 2) throw Error('Reply mutation anchor is missing or ambiguous')
      loaded = code.replace(change.before, change.after)
      if (change.also) {
        const start = loaded.indexOf('if (isMoteChatMethod(method)) {'), end = loaded.indexOf('if (isMoteConnectionMethod(method))', start)
        let block = loaded.slice(start, end)
        for (const patch of change.also) { if (block.split(patch.before).length !== 2) throw Error('Fence mutation anchor missing or ambiguous'); block = block.replace(patch.before, patch.after) }
        loaded = loaded.slice(0, start) + block + loaded.slice(end)
      }
    }
    if (process.env.MOTE_CREATOR_REPLY_LOADED) appendFileSync(process.env.MOTE_CREATOR_REPLY_LOADED, JSON.stringify({ path,
      originalSHA256: createHash('sha256').update(code).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex'), ...(path === change?.path ? { mutation: mutant } : {}) }) + '\n')
    if (loaded !== code) return loaded
  } }, ...main.plugins!],
  test: { ...main.test, include: ['packages/connectors/test/mote-creator-reply.integration.test.ts', 'packages/connectors/test/mote-creator-main.integration.test.ts'],
    passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
