import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const inverse = process.env.BROWSER_RECOVERY_INVERSE ? JSON.parse(readFileSync(process.env.BROWSER_RECOVERY_INVERSE, 'utf8')) : undefined
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
export default defineConfig({
  ...base,
  cacheDir: resolve(root, '.cache/browser-recovery-first-presentation'),
  define: { ...base.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  plugins: [{
    name: 'original-browser-recovery-consumer-source', enforce: 'pre',
    transform(original, id) {
      const file = relative(root, id.split('?')[0]!)
      if ((!file.startsWith('apps/') && !file.startsWith('packages/')) || file.includes('/node_modules/')) return
      let source = original
      // Retain the real native-presentation branches while controlling the maintained typed API leaf.
      if (file === 'apps/desktop/src/renderer/src/lib/api.ts') {
        const seam = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
        if (source.split(seam).length !== 2) throw Error('One maintained typed Browser API fixture seam')
        source = source.replace(seam, 'export const api = mockApi')
      }
      if (inverse?.file === file) {
        const occurrences = inverse.occurrences ?? 1
        if (source.split(inverse.before).length !== occurrences + 1) throw Error('Inverse must bind the exact recovery owner site: ' + inverse.name)
        source = source.split(inverse.before).join(inverse.after)
      }
      if (process.env.BROWSER_RECOVERY_LOADED) appendFileSync(process.env.BROWSER_RECOVERY_LOADED, JSON.stringify({
        file, sourceSHA256: sha(original), loadedSHA256: sha(source),
        ...(inverse?.file === file ? { mutation: inverse.name } : {}),
        ...(file === 'apps/desktop/src/renderer/src/lib/api.ts' ? { fixtureLeaf: 'maintained typed API' } : {})
      }) + '\n')
      return source === original ? undefined : { code: source, map: null }
    }
  }],
  test: { ...base.test, include: ['apps/desktop/test/browser-recovery-first-presentation.test.tsx'],
    exclude: [], globalSetup: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 10000 }
})
