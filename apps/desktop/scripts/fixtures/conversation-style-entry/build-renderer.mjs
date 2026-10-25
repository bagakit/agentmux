import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { aliases, root, desktopRequire, installedDependency } from './environment.mjs'
const [outDir, inputPath, receiptPath, fixture = import.meta.dirname, avatarPort] = process.argv.slice(2)
const sources = JSON.parse(await readFile(inputPath, 'utf8')), loaded = new Set()
const avatarEdges = new Set()
const storeEdges = new Map(), storePath = join(root, 'apps/desktop/src/renderer/src/store')
const noticeHook = 'apps/desktop/src/renderer/src/lib/use-service-notices.ts'
const receiptPort = 'apps/desktop/scripts/fixtures/conversation-style-entry/notice-receipts.ts'
const hash = value => createHash('sha256').update(value).digest('hex')
const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
  resolve: { alias: [{ find: /^jsonc-parser$/, replacement: join(dirname(desktopRequire.resolve('jsonc-parser/package.json')), 'lib/esm/main.js') }, ...aliases] },
  define: { 'process.env.NODE_ENV': '"production"', __AGENTMUX_WEB_PREVIEW__: 'true' }, worker: { format: 'es' },
  plugins: [{ name: 'actual-style-consumers', enforce: 'pre', resolveId(source, importer) {
    if (avatarPort && source === './ConversationMessageAvatar' && importer && relative(root, importer.split('?')[0]) === 'apps/desktop/src/renderer/src/components/ConversationAxis.tsx') {
      avatarEdges.add(relative(root, importer.split('?')[0])); return avatarPort
    }
    const requested = importer && (source.startsWith('.') || source.startsWith('/'))
      ? resolve(dirname(importer.split('?')[0]), source).replace(/\.(?:tsx?|js)$/u, '') : null
    if (requested === storePath) {
      const consumer = relative(root, importer.split('?')[0])
      assert.equal(consumer, noticeHook, `Unexpected second Desktop Store importer: ${consumer}`)
      assert.equal(source, '../store', 'Only the original notice acknowledgement IO edge is adapted')
      storeEdges.set(consumer, { importer: consumer, source, port: receiptPort })
      return join(root, receiptPort)
    }
    if (/(?:^|\/)api(?:\.ts)?$/u.test(source) && importer?.includes('/renderer/src/')) return join(fixture, 'api.ts')
    return installedDependency(source, importer)
  }, transform(code, id) { const file = relative(root, id.split('?')[0]); assert.notEqual(file, 'apps/desktop/src/renderer/src/store.ts', 'The full Desktop Store must not bypass its exact IO edge')
    if (!(file in sources)) return null
    assert.equal(hash(code), sources[file]); loaded.add(file); return null
  } }], build: { outDir, emptyOutDir: true, minify: false } })
for (const file of Object.keys(sources)) assert.ok(loaded.has(file), `${file}: the actual consumer must compile`)
assert.equal(storeEdges.size, 1, 'The original notice Hook must consume exactly one private acknowledgement IO edge')
assert.equal(avatarEdges.size, avatarPort ? 1 : 0, 'Only the supplied-avatar fixture may replace its unused Axis fallback')
await writeFile(receiptPath, JSON.stringify({ loaded: [...loaded], avatarBoundary: avatarPort ? { importer: [...avatarEdges][0], port: relative(root, avatarPort), boundary: 'The fixture supplies the actual provider avatar. Invoking the unused global-identity fallback throws and is counted.' } : null, storeIO: { edges: [...storeEdges.values()],
  allowedStateKeys: ['noticeReadReceipts'], initialState: { noticeReadReceipts: {} }, allowedActions: ['selector', 'getState', 'setState'],
  boundary: 'Actual Zustand selector/subscription and read/write of private UI acknowledgement receipts only. Every other state key/action and Store importer fails.' } }))
