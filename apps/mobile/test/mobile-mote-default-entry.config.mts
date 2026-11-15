import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mobileRequire = createRequire(resolve(root, 'apps/mobile/package.json'))
const runtime = `export const identityRuntimeSource = ${JSON.stringify((await bundleIdentityRuntime()).source)};\n`
const mutations: Record<string, { before: string; after: string; target?: string }> = {
  'intermediate-directory': { before: '    const showDirectory = (issue: string) => {', after: "    setHome('mote'); setSecondary(null); setShowSession(false)\n    const showDirectory = (issue: string) => {", target: 'retains the current page' },
  'focus-in-mote': { before: 'const focusShown = focusRoot || sidebarShown && !moteConversation\n  const moteDirectoryShown = moteDirectoryRoot || sidebarShown && moteConversation', after: 'const focusShown = focusRoot || sidebarShown\n  const moteDirectoryShown = moteDirectoryRoot', target: 'retains the current page' },
  'bottom-entry': { before: "if (value === 'mote') { void enterMote(recentMoteSpaceId); return }", after: "if (value === 'mote') { setHome('mote'); setSecondary(null); setShowSession(false); return }" },
  'row-entry': { before: 'void enterMote(id)', after: 'setRecentMoteSpaceId(id)' },
  'late-entry': { before: 'if (!isCurrent()) return\n      const owner = mobileMoteOwner', after: 'if (false) return\n      const owner = mobileMoteOwner' },
  'exact-object': { before: 'mobileChatStart({ ...catalog, spaces: [owner] }, owner.spaceId)', after: 'mobileChatStart(catalog, owner.spaceId)' },
  'initial-global-presentation': { before: "client.forwardRpc!('space.ls', { target: {} })", after: "client.forwardRpc!('space.ls', { target: {}, presentation: true })", target: 'discovers the typed primary without global presentation on startup' },
  'explicit-global-presentation': { before: "source.forwardRpc('space.ls', { target: {} })", after: "source.forwardRpc('space.ls', { target: {}, presentation: true })", target: 'discovers the typed primary without global presentation from the bottom bar' },
  'startup-late-discovery': { before: 'if (!isCurrent()) return\n      const primary = mobileMoteOwner', after: 'if (false) return\n      const primary = mobileMoteOwner', target: 'does not advance a stale startup discovery across navigation' },
  'changed-primary-owner': { before: 'mobileMoteOwner(catalog, primary.spaceId, primary)', after: 'mobileMoteOwner(catalog, primary.spaceId)', target: 'rejects a changed primary owner in the exact presentation \\(host\\)' }
}
const name = process.env.AGENTMUX_TEST_MOTE_ENTRY_MUTATION, report = process.env.AGENTMUX_TEST_MOTE_ENTRY_TRACE
if (name && !Object.hasOwn(mutations, name)) throw new Error('Unknown Mote entry mutation: ' + name)
const variant = name ? mutations[name]! : undefined
const owners = new Set(['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/navigation/chat-start.ts',
  'apps/mobile/test/mobile-chat-start.test.tsx', 'apps/mobile/test/mobile-mote-default-entry.test.tsx'])
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
// node node_modules/vitest/vitest.mjs run --config apps/mobile/test/mobile-mote-default-entry.config.mts
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/mobile-mote-default-entry', name ?? 'normal'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ name: 'loaded-mobile-mote-default-entry', enforce: 'pre',
    resolveId(id) { if (id === '@agentmux/identity/runtime-source') return '\0mote-entry-identity'; return workspaceSourceExport(root, id) },
    load(id) { if (id === '\0mote-entry-identity') return runtime },
    transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    const app = file === 'apps/mobile/src/MobileApp.tsx', mutation = app ? variant : undefined
    if (mutation && source.split(mutation.before).length !== 2) throw new Error('Mote entry mutation marker changed: ' + name)
    let code = mutation ? source.replace(mutation.before, mutation.after) : source
    const marker = { name: name ?? 'baseline', file, originalSha256: sha(readFileSync(id.split('?')[0]!, 'utf8')), loadedSha256: sha(code), mutation: mutation ? name : null }
    if (report) {
      appendFileSync(report, JSON.stringify({ phase: 'loaded', ...marker }) + '\n')
      code = `import {appendFileSync as __moteEntryTrace} from 'node:fs'; __moteEntryTrace(${JSON.stringify(report)}, ${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...marker }) + '\n')});\n` + code
    }
    if (app) code += '\n;globalThis.__mobileMoteEntryEvaluated = ' + JSON.stringify(marker) + ';\n'
    return code === source ? undefined : { code, map: null }
  } }], esbuild: { jsx: 'automatic' },
  resolve: { alias: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-dom/server', 'react-dom/test-utils'].map(name => ({ find: new RegExp('^' + name + '$'), replacement: mobileRequire.resolve(name) })), conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  test: { include: ['apps/mobile/test/mobile-mote-default-entry.test.tsx', 'apps/mobile/test/mobile-chat-start.test.tsx'], testNamePattern: variant?.target, environment: 'happy-dom',
    env: { MOBILE_TEST_BUILD_ID: 'reviewed-page-build' },
    setupFiles: [resolve(root, 'apps/mobile/test/device-locks.ts'), resolve(root, 'apps/mobile/test/mobile-build-identity-setup.ts')],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, restoreMocks: true, testTimeout: 20000 }
})
