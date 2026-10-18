import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'request-allocator': ['packages/core/src/client-request-id.ts', "export { mintObjectId as randomClientRequestId } from './object-id.js'", "export function randomClientRequestId() { return 'fc69400b-bc24-4915-b35f-01a26a085af9' }"],
  'cli-operation': ['packages/core/src/agentmux-cli-commands.ts', "f.values.has('--operation-id') ? id(f, '--operation-id') : mintObjectId()", "f.values.has('--operation-id') ? id(f, '--operation-id') : 'fc69400b-bc24-4915-b35f-01a26a085af9'"],
  'avatar-uuid-only': ['packages/core/src/mote-avatar-write.ts', '/^[A-Za-z0-9_-]{1,128}$/u', '/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u'],
  'reading-view': ['packages/core/src/conversation-reader.ts', 'const view: ReadingView = { ...ref, id: mintObjectId(),', "const view: ReadingView = { ...ref, id: 'legacy-reading-view',"],
  'captured-epoch': ['packages/core/src/captured-history.ts', '.run(id, mintObjectId(),', ".run(id, 'legacy-captured-epoch',"],
  'registry-reservation': ['packages/core/src/agent-session-registry.ts', 'reservationId: mintObjectId(),\n      ownerId:', "reservationId: 'legacy-reservation',\n      ownerId:"],
  'observer-source': ['packages/core/src/providers/claude-native-activity.ts', 'const sourceId = mintObjectId()', "const sourceId = 'legacy-observer-source'"],
  'pi-receipt': ['packages/core/src/providers/pi.ts', 'receiptId: mintObjectId(),', "receiptId: 'legacy-hook-receipt',"],
  'rpc-request': ['packages/core/src/public-rpc-client.ts', "id: mintObjectId(), method,", "id: 'fc69400b-bc24-4915-b35f-01a26a085af9', method,"],
  'rpc-subscription': ['packages/core/src/public-rpc-wire.ts', 'const subscriptionId = mintObjectId()', "const subscriptionId = 'legacy-subscription'"],
}
const selected = process.env.AMUX_IDENTIFIER_MUTATION
if (selected && !mutations[selected]) throw new Error('Unknown unified identifier source mutation')
export default defineConfig({ root,
  plugins: [{ name: 'unified-identifier-source-proof', enforce: 'pre', transform(source, id) {
    if (id.includes('?')) return
    const path = relative(root, id)
    if (!/^packages\/(core|identity)\/(src|test)\//u.test(path)) return
    const change = selected ? mutations[selected] : undefined
    let code = source
    if (change?.[0] === path) {
      if (source.split(change[1]).length !== 2) throw new Error('Unified identifier mutation anchor must occur exactly once: ' + selected)
      code = source.replace(change[1], change[2])
    }
    if (process.env.AMUX_IDENTIFIER_LOADED) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.AMUX_IDENTIFIER_LOADED, JSON.stringify({ path, sourceSHA: sha(source), loadedSHA: sha(code), mutation: code === source ? null : selected }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }],
  test: { include: ['packages/core/test/unified-identifiers.test.ts', ...(process.env.AMUX_IDENTIFIER_ADJACENT === '1' ? [
    'packages/core/test/hook-delivery-recovery.test.ts',
    'packages/core/test/unified-object-id-consumers.test.ts',
    'packages/core/test/providers/claude.test.ts',
    'packages/core/test/login-shell-environment.test.ts',
    'packages/core/test/control-endpoint-publication.test.ts',
    'packages/core/test/session-history-query.test.ts',
    'packages/core/test/headless-runtime-continuity.integration.test.ts',
  ] : [])],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false,
    fileParallelism: false, maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000 }
})
