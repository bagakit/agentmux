import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const coreExports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const coreAliases = Object.entries(coreExports).map(([key, value]) => ({
  find: new RegExp(`^${key === '.' ? '@agentmux/core' : `@agentmux/core${key.slice(1)}`}$`),
  replacement: resolve(root, 'packages/core', (value as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
const mutations: Record<string, [string, string, string]> = {
  'wrong-host': ['apps/desktop/src/renderer/src/components/SessionPane.tsx', "recoveryCandidate?.hostId ?? retainedHistory?.hostId ?? ''", "'local'"],
  'drop-size': ['packages/core/src/session-history.ts', 'sourceSizeBytes', 'MUTATION_DROP_SIZE_ANCHOR'],
  'fake-time': ['apps/desktop/src/renderer/src/components/SessionRecap.tsx', 'return times.length ? Math.max(...times) : undefined', 'return Date.now()'],
  'page-as-total': ['apps/desktop/src/renderer/src/components/SessionRecap.tsx', "page.nextCursor === null ? '' : '+'", "''"],
  'foreign-capture': ['apps/desktop/src/renderer/src/components/SessionRecap.tsx', "projected?.kind !== 'agent' || projected.control.hostId !== hostId", 'false']
}
export default defineConfig({ ...original, root, cacheDir: resolve(root, ".tmp/session-recovery-context-fixture/vite-cache"),
  resolve: { alias: [...coreAliases,
    { find: /^@agentmux\/layout$/, replacement: resolve(root, 'packages/layout/src/index.ts') },
    { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/components/$1.tsx') },
    { find: /^@agentmux\/client-ui\/platform$/, replacement: resolve(root, 'packages/client-ui/src/platform.tsx') },
    { find: /^@agentmux\/client-ui\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/lib/$1.ts') },
    { find: /^@agentmux\/client-ui$/, replacement: resolve(root, 'packages/client-ui/src/index.ts') }
  ] },
  plugins: [...(original.plugins ?? []), { name: 'context-actual-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(apps\/desktop\/src|packages\/core\/src)\/.+\.[jt]sx?$/.test(path)) return
    const before = code, mutation = process.env.AGENTMUX_CONTEXT_MUTATION
    if (mutation && !mutations[mutation]) throw new Error('Unknown context mutation')
    if (mutation && mutations[mutation]![0] === path) {
      const [, anchor, replacement] = mutations[mutation]!
      if (mutation === 'drop-size') {
        const sizeReturn = /\.\.\.\(Number\.isSafeInteger\(page\.sourceSizeBytes\)[\s\S]*?\? \{ sourceSizeBytes: page\.sourceSizeBytes as number \} : \{\}\)/
        if (!sizeReturn.test(code)) throw new Error('Missing size return mutation anchor')
        code = code.replace(sizeReturn, '...{}')
      } else {
        if (code.split(anchor).length !== 2) throw new Error('Missing unique mutation anchor: ' + mutation)
        code = code.replace(anchor, replacement)
      }
    }
    const output = process.env.AGENTMUX_CONTEXT_LOADED
    if (output) appendFileSync(output, JSON.stringify({ path, mutation: before !== code ? mutation : null,
      sourceSHA256: createHash('sha256').update(before).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    if (before !== code) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], fileParallelism: false, passWithNoTests: false,
    include: ['apps/desktop/test/session-recap.test.tsx', 'apps/desktop/test/session-connecting-surface.test.tsx',
      'packages/core/test/session-recovery-context.test.ts'] }
})
