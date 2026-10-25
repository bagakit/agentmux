import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'service-inspect-reparse': ['packages/core/src/public-rpc-service.ts', 'parseConversationReadPageForWindow(page, request)', "(await import('./conversation-changes.js')).parseConversationReadPage(page, request)"],
  'service-changes-reparse': ['packages/core/src/public-rpc-service.ts', 'parseConversationChangesPageForWindow(page, request)', "(await import('./conversation-changes.js')).parseConversationChangesPage(page, request)"],
  'reader-copy': ['packages/core/src/conversation-reader.ts', 'return parsed\n  } finally { releaseRead() }', 'return structuredClone(parsed)\n  } finally { releaseRead() }'],
  'copy-items': ['packages/core/src/conversation-changes.ts', "key === 'items' && retainItems ? value : immutablePageValue(value)", 'immutablePageValue(value)'],
  'borrow-source': ['packages/core/src/conversation-changes.ts', 'source.hostId === original.sourceHostId && ', ''],
  'borrow-scope': ['packages/core/src/conversation-changes.ts', ' && same(accepted, original.scope)', ''],
  'premature-budget': ['packages/core/src/conversation-reader.ts', 'const overflow = Buffer.byteLength(JSON.stringify(result)) - budget', 'parseRoutedConversationPage(page, result, input)\n    const overflow = Buffer.byteLength(JSON.stringify(result)) - budget']
}
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/conversation-route-owner'),
  resolve: { alias: [
    { find: /^@agentmux\/core\/conversation$/u, replacement: resolve(root, 'packages/core/src/conversation.ts') },
    { find: /^@agentmux\/core$/u, replacement: resolve(root, 'packages/core/src/index.ts') }
  ] },
  plugins: [{ name: 'original-conversation-route-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(packages\/(core|connectors)\/src\/).+\.ts$/u.test(path)) return
    const mutation = process.env.AGENTMUX_ROUTE_OWNER_MUTATION, selected = mutation ? mutations[mutation] : undefined
    if (mutation && !selected) throw Error('Unknown route owner mutation')
    let code = source
    if (selected && path === selected[0]) {
      if (source.split(selected[1]).length !== 2) throw Error('Missing unique route owner mutation: ' + mutation)
      code = source.replace(selected[1], selected[2])
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_ROUTE_OWNER_LOADED) appendFileSync(process.env.AGENTMUX_ROUTE_OWNER_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), loadedSHA256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    if (code !== source) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], include: [
    'packages/core/test/conversation-page-owner.test.ts',
    'packages/core/test/conversation-route-owner.test.ts',
    'packages/core/test/conversation-reader-lifetime.test.ts'
  ], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 }
})
