import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutants: Record<string, [string, string, string]> = {
  'forget-legacy-main': ['packages/core/src/providers/codex-native-catalog.ts', "const legacyMain = payload!.source === undefined && ['codex_cli_rs', 'codex_vscode'].includes(String(payload!.originator)) &&\n    typeof payload!.cli_version === 'string' && payload!.cli_version.trim().length > 0", 'const legacyMain = false'],
  'skip-preview-precheck': ['packages/core/src/client.ts', 'await read(assertSource())\n      const page = await read(provider.readSessionHistoryPage({ source, limit', 'const page = await read(provider.readSessionHistoryPage({ source, limit'],
  'skip-preview-postcheck': ['packages/core/src/client.ts', 'controller.signal.throwIfAborted()\n      await read(assertSource())\n      return normalizeSessionHistoryPage(source, page, limit)', 'controller.signal.throwIfAborted()\n      return normalizeSessionHistoryPage(source, page, limit)'],
  'drop-private-source-env': ['packages/core/src/client.ts', 'const env = input.env ?? {}, source = { providerId: provider.id, nativeSessionId: native.nativeHandle.sessionId }', 'const env = {}, source = { providerId: provider.id, nativeSessionId: native.nativeHandle.sessionId }'],
  'drop-saved-speech': ['packages/core/src/providers/codex-saved-history.ts', 'if (converted) items.push(converted)', 'if (false) items.push(converted)'],
  'accept-foreign-page': ['packages/core/src/client.ts', 'return normalizeSessionHistoryPage(source, page, limit)', 'return page'],
  'accept-foreign-resource': ['packages/core/src/client.ts', 'if (request.source.providerId !== source.providerId || request.source.nativeSessionId !== source.nativeSessionId)', 'if (false)'],
  'accept-unrecorded-image': ['packages/core/src/client.ts', "if (item.id !== request.recordId || request.turnId !== undefined && item.turnId !== request.turnId ||\n        part?.kind !== 'resource' || part.resourceType !== 'image' || part.reference !== request.expectedReference)", 'if (false)'],
  'drop-resource-sid-lock': ['packages/core/src/session-history-content.ts', "(identityRead && (Object.hasOwn(receipt, 'agentSessionId') !== identityPresent || receipt.agentSessionId !== agentSessionId))", 'false']
}
export default defineConfig({ root, plugins: [{ name: 'native-preview-actual-source', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!path.startsWith('packages/core/src/')) return
  let code = source
  const mutation = process.env.AMX_NATIVE_PREVIEW_MUTATION, change = mutation && mutants[mutation]
  if (mutation && !change) throw new Error('Unknown native preview mutant')
  if (change && path === change[0]) {
    if (code.split(change[1]).length !== 2) throw new Error('Native preview source anchor must match once: ' + mutation)
    code = code.replace(change[1], change[2])
  }
  if (process.env.AMX_NATIVE_PREVIEW_LOADED) appendFileSync(process.env.AMX_NATIVE_PREVIEW_LOADED, JSON.stringify({ path,
    sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'),
    ...(code !== source ? { mutation } : {}) }) + '\n')
  if (code !== source) return { code, map: null }
} }], test: { include: ['packages/core/test/native-session-preview.test.ts', 'packages/core/test/session-history-content-native-identity.test.ts'], passWithNoTests: false,
  fileParallelism: false, maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000 } })
