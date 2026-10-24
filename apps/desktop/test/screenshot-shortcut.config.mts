import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { radixOverlayAliases } from '../scripts/radix-overlay-aliases'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_SCREENSHOT_SHORTCUT_MUTATION ? JSON.parse(process.env.AGENTMUX_SCREENSHOT_SHORTCUT_MUTATION) : null
const client = resolve(root, 'packages/client-ui')
const clientExports = JSON.parse(readFileSync(resolve(client, 'package.json'), 'utf8')).exports
// Renderer browser exports are the production source contract; Node's dist branch is not this candidate.
const clientAliases = Object.entries(clientExports).sort(([left], [right]) => right.length - left.length).flatMap(([key, spec]) => {
  const target = typeof spec === 'string' ? spec : (spec as { browser?: string }).browser
  if (!target?.startsWith('./src/')) return []
  const name = '@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))
  const pattern = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)')
  return [{ find: new RegExp(`^${pattern}$`), replacement: resolve(client, target).replace('*', '$1') }]
})
const maintained = new Set(['packages/client-ui/src/components/InlineComposer.tsx', 'packages/client-ui/src/lib/composer-insertion.ts'])
export default defineConfig({
  cacheDir: resolve(root, '.tmp/screenshot-shortcut-cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [
    ...clientAliases,
    ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement })),
    { find: '@agentmux/native-desktop/image', replacement: resolve(root, 'packages/native-desktop/src/image.ts') },
    { find: '@agentmux/native-desktop', replacement: resolve(root, 'packages/native-desktop/src/index.ts') }
  ] },
  plugins: [{ name: 'screenshot-shortcut-private-mutation', enforce: 'pre', load(id) {
    const file = relative(root, id.split('?')[0])
    const changes = mutation?.file === file
    if (!changes && !maintained.has(file)) return
    const source = readFileSync(id.split('?')[0], 'utf8')
    if (changes && source.split(mutation.from).length !== 2) throw new Error('Non-unique production mutation: ' + mutation.id)
    const changed = changes ? source.replace(mutation.from, mutation.to) : source
    if (process.env.AGENTMUX_SCREENSHOT_SHORTCUT_LOADED) appendFileSync(process.env.AGENTMUX_SCREENSHOT_SHORTCUT_LOADED,
      JSON.stringify({ file, sourceSha256: createHash('sha256').update(source).digest('hex'), loadedSha256: createHash('sha256').update(changed).digest('hex'),
        mutation: changes ? mutation.id : null }) + '\n')
    return id.includes('?raw') ? 'export default ' + JSON.stringify(changed) : changed
  } }],
  test: { include: ['apps/desktop/test/screenshot-shortcut*.test.{ts,tsx}',
    'apps/desktop/test/{shortcut-registry,shortcut-cheat-sheet,settings-keyboard-shortcuts}.test.{ts,tsx}'], environment: 'node',
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 10000 }
})
