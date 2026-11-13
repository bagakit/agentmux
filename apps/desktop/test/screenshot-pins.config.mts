import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { appendFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.SCREENSHOT_PINS_MUTATION ? JSON.parse(process.env.SCREENSHOT_PINS_MUTATION) : null
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/screenshot-pins-cache'),
  resolve: { alias: [
    { find: /^@agentmux\/core$/, replacement: resolve(root, 'packages/core/src/index.ts') },
    { find: /^@agentmux\/native-desktop\/image$/, replacement: resolve(root, 'packages/native-desktop/src/image.ts') },
    { find: /^@agentmux\/client-ui\/theme$/, replacement: resolve(root, 'packages/client-ui/src/theme/index.ts') }
  ] },
  plugins: [{ name: 'screenshot-pins-production-source', enforce: 'pre', async load(id) {
    if (!id.endsWith('/apps/desktop/src/main/screenshot-pins.ts')) return
    const source = await readFile(id, 'utf8')
    if (mutation && source.split(mutation.from).length !== 2) throw new Error('Pin mutation must address one production owner statement')
    const consumed = mutation ? source.replace(mutation.from, mutation.to) : source
    if (process.env.SCREENSHOT_PINS_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      await appendFile(process.env.SCREENSHOT_PINS_LOADED, JSON.stringify({ source: hash(source), consumed: hash(consumed), mutation: mutation?.id ?? null }) + '\n')
    }
    return consumed
  } }],
  test: { include: ['apps/desktop/test/screenshot-pins.test.ts'], environment: 'node', passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false, testTimeout: 10000 }
})
