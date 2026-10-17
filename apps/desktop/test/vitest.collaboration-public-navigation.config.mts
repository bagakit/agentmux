import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './vitest.performance-reading.config.mts'
import { desktopMapMutations } from './helpers/desktop-map-source-mutations.mjs'
export { desktopMapMutations }
const selected = process.env.AGENTMUX_DESKTOP_MAP_MUTATION, mutation = desktopMapMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown map source mutation')
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
export default defineConfig({ ...base, cacheDir: '.cache/collaboration-public-navigation', plugins: [...base.plugins!, {
  name: 'actual-public-map-source', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    let effective = source
    if (mutation?.file === path) {
      if (source.split(mutation.before).length !== 2) throw Error('Unique map source mutation anchor required')
      effective = source.replace(mutation.before, mutation.after)
    }
    const log = process.env.AGENTMUX_DESKTOP_MAP_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path, originalSHA256: sha(source), effectiveSHA256: sha(effective), process: 'product-tests' }) + '\n')
    return effective === source ? undefined : { code: effective, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/control-desktop-map.test.ts', 'apps/desktop/test/desktop-map-presentation.test.ts', 'apps/desktop/test/desktop-presentation-primary.test.ts'], passWithNoTests: false } })
