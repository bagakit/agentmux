import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const repository = resolve(import.meta.dirname, '../../../../..')
// This bounded file gate consumes current Source directly. It does not build or
// claim freshness of Core's published dist, nor exercise a live Runtime/Run.
const aliases = ['core', 'demand', 'layout', 'client-ui'].flatMap(name => {
  const directory = resolve(repository, 'packages', name)
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { import: string; browser?: string }>
  }
  // Exact exports precede wildcard exports, and narrower wildcard prefixes
  // precede the package-wide wildcard, matching package resolution semantics.
  const entries = Object.entries(manifest.exports).sort(([a], [b]) =>
    Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
  if (!entries.length) throw new Error(`No public ${name} exports were found`)
  return entries.map(([subpath, target]) => {
    if (name === 'client-ui') {
      const source = typeof target === 'string' ? target : target.browser
      if (!source?.startsWith('./src/')) throw new Error(`Unmapped ${name} Source export: ${subpath}`)
      const parts = subpath === '.' ? ['@agentmux/client-ui'] : ('@agentmux/client-ui' + subpath.slice(1)).split('*')
      const expression = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
      const replacement = resolve(directory, source.replace('*', '$1'))
      if (!subpath.includes('*') && !existsSync(replacement)) throw new Error(`Missing current Source for ${subpath}: ${replacement}`)
      return { find: new RegExp('^' + expression + '$'), replacement }
    }
    if (typeof target === 'string') throw new Error(`Unmapped ${name} Source export: ${subpath}`)
    if (name !== 'layout' && (!target.import.startsWith('./dist/') || !target.import.endsWith('.js')))
      throw new Error(`Unmapped ${name} Source export: ${subpath}`)
    const specifier = '@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))
    const source = target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
    const replacement = resolve(directory, source)
    if (!existsSync(replacement)) throw new Error(`Missing current Source for ${specifier}: ${replacement}`)
    return { find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement }
  })
})

export default defineConfig({
  root: resolve(repository, 'apps/desktop'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { dedupe: ['react', 'react-dom', 'lucide-react'], alias: [...aliases,
    { find: /^json-rpc-2\.0$/, replacement: resolve(repository, 'node_modules/.pnpm/json-rpc-2.0@1.8.1/node_modules/json-rpc-2.0/dist/index.js') },
    { find: /^@agentmux\/client-ui$/, replacement: resolve(repository, 'packages/client-ui/src/index.ts') },
    { find: /^@agentmux\/client-ui\/platform$/, replacement: resolve(repository, 'packages/client-ui/src/platform.tsx') },
    { find: /^@agentmux\/client-ui\/styles\/(.+)$/, replacement: resolve(repository, 'packages/client-ui/src/styles/$1') },
    { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: resolve(repository, 'packages/client-ui/src/components/$1.tsx') },
    { find: /^@agentmux\/client-ui\/terminal\/(.+)$/, replacement: resolve(repository, 'packages/client-ui/src/terminal/$1.ts') },
    { find: /^@agentmux\/client-ui\/(.+)$/, replacement: resolve(repository, 'packages/client-ui/src/lib/$1.ts') }
  ] },
  test: {
    setupFiles: [resolve(repository, 'vitest.setup.ts')],
    include: ['test/file-save-store.test.ts', 'test/file-preview-pane.test.tsx', 'test/file-save-recovery-filesystem.test.ts'],
    passWithNoTests: false,
    maxWorkers: 1
  }
})
