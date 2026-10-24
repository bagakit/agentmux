import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_NATIVE_CONSUMER_MUTATION ? JSON.parse(process.env.AGENTMUX_NATIVE_CONSUMER_MUTATION) : null
export default defineConfig({
  cacheDir: resolve(root, '.tmp/native-consumers-cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: [
    { find: '@agentmux/native-desktop/image', replacement: resolve(root, 'packages/native-desktop/src/image.ts') },
    { find: '@agentmux/native-desktop', replacement: resolve(root, 'packages/native-desktop/src/index.ts') }
  ] },
  plugins: [{ name: 'native-consumer-private-mutation', enforce: 'pre', load(id) {
    if (!mutation || id.split('?')[0] !== resolve(root, mutation.file)) return
    const source = readFileSync(id.split('?')[0], 'utf8')
    if (source.split(mutation.from).length !== 2) throw new Error('Non-unique production mutation: ' + mutation.id)
    const mutated = source.replace(mutation.from, mutation.to)
    return id.includes('?raw') ? 'export default ' + JSON.stringify(mutated) : mutated
  } }],
  test: { include: ['apps/desktop/test/{native-desktop-owner,native-desktop-consumers,native-composer-consumers,screen-capture,browser-image,browser-screenshot-source,browser-screenshot-workface,composer-local-feedback,composer-paste-selection,clipboard-copy,terminal-osc-clipboard,terminal-multiline-paste,browser-external-target,browser-input-selection-ipc}.test.{ts,tsx}'],
    environment: 'node', passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 10000 }
})
