import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './performance-capture.config.mts'

const root = original.root!
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/performance-scene-ui'),
  plugins: [...original.plugins ?? [], { name: 'performance-scene-real-consumers', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (process.env.AGENTMUX_SCENE_UI_LOADED && (path.startsWith('apps/desktop/src/') || path.startsWith('packages/'))) {
      appendFileSync(process.env.AGENTMUX_SCENE_UI_LOADED, JSON.stringify({ path, sha256: hash(original) }) + '\n')
    }
  } }], test: { ...original.test, include: ['apps/desktop/test/performance-scene-ui.fixture.tsx'],
    globalSetup: [], setupFiles: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false } })
