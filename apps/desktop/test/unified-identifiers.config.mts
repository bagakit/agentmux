import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'
const root = resolve(import.meta.dirname, '../../..')
const core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases: Record<string, string> = { '@agentmux/identity': resolve(root, 'packages/identity/src/index.ts'), 'ws': resolve(root, 'apps/desktop/node_modules/ws/wrapper.mjs') }
for (const [name, entry] of Object.entries(core.exports) as [string, { import?: string }][]) {
  if (!entry.import) continue
  const source = resolve(root, 'packages/core', entry.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  if (existsSync(source)) aliases[name === '.' ? '@agentmux/core' : '@agentmux/core/' + name.slice(2)] = source
}
import { clientIdentityMutations } from '../scripts/lib/unified-identifier-mutations.mjs'
const mutation = process.env.AMUX_CLIENT_ID_MUTATION ? clientIdentityMutations[process.env.AMUX_CLIENT_ID_MUTATION] : undefined
if (process.env.AMUX_CLIENT_ID_MUTATION && !mutation) throw new Error('Unknown client identity mutation')
const selected = [
  'apps/desktop/test/browser-operation-journal.test.ts', 'apps/desktop/test/unified-note-identifiers.test.ts',
  'apps/desktop/test/note-wikilinks-editor.test.tsx', 'apps/desktop/test/preload-history-observation.test.ts',
  'apps/desktop/test/workbench-windows.test.ts', 'apps/desktop/test/workbench-window-store.test.ts',
  'apps/desktop/test/client-incident-ipc.test.ts', 'apps/desktop/test/unified-browser-identifiers.test.ts',
  'apps/desktop/test/unified-object-id-store.test.ts', 'apps/desktop/test/message-tool-workspace.test.tsx',
  'apps/mobile/test/native-workface-file.test.ts', 'apps/desktop/test/client-incident-temp-cleanup.test.ts',
  'packages/core/test/performance-input-correlation.test.ts'
]
export default defineConfig({ ...original, root,
  resolve: { alias: Object.entries(aliases).map(([name, replacement]) => ({ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement })), conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  plugins: [{ name: 'client-identity-source-proof', enforce: 'pre', transform(source, id) {
    const name = relative(root, id.split('?')[0]!)
    if (!name.startsWith('apps/') && !name.startsWith('packages/')) return
    let code = source
    if (mutation && name === mutation.file) {
      if (!source.includes(mutation.before)) throw new Error('The actual client mutation source anchor is missing')
      code = source.replaceAll(mutation.before, mutation.after)
    }
    if (process.env.AMUX_CLIENT_ID_LOADED) appendFileSync(process.env.AMUX_CLIENT_ID_LOADED, JSON.stringify({ path: name, sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutated: source !== code }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], include: mutation ? [mutation.test] : selected, fileParallelism: false, maxWorkers: 1,
    environment: 'happy-dom', passWithNoTests: false, testTimeout: 30_000 }
})
