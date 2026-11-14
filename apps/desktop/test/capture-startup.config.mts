import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.CAPTURE_STARTUP_MUTATION ? JSON.parse(process.env.CAPTURE_STARTUP_MUTATION) : null
const sources = ['apps/desktop/src/main/capture-surface.ts', 'apps/desktop/src/main/ipc.ts']
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export default defineConfig({
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.tmp/capture-startup-cache'),
  resolve: { alias: { '@agentmux/native-desktop/image': resolve(root, 'packages/native-desktop/src/image.ts'), '@agentmux/client-ui/theme': resolve(root, 'packages/client-ui/src/theme/index.ts') } },
  plugins: [{ name: 'capture-startup-exact-production-counterexample', enforce: 'pre', load(id) {
    const path = id.split('?')[0], file = relative(root, path)
    if (!sources.includes(file)) return
    const original = readFileSync(path, 'utf8')
    const mutated = mutation?.file === file
    if (mutated && original.split(mutation.from).length !== 2) throw new Error('Mutation anchor must be unique: ' + mutation.id)
    const consumed = mutated ? original.replace(mutation.from, mutation.to) : original
    appendFileSync(process.env.CAPTURE_STARTUP_LOADED!, JSON.stringify({ file, original: hash(original), consumed: hash(consumed), mutation: mutated ? mutation.id : null }) + '\n')
    return id.includes('?raw') ? 'export default ' + JSON.stringify(consumed) : consumed
  } }],
  test: { include: ['apps/desktop/test/capture-surface.test.ts', 'apps/desktop/test/capture-startup-preload.test.ts', 'apps/desktop/test/capture-surface-view.test.tsx', 'apps/desktop/test/screenshot-shortcut-wiring.test.ts'], environment: 'node', passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
