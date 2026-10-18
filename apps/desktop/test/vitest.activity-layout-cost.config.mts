import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.conversation-unified-consumers.config.mts'
import { candidateAlias, candidateModule } from '../scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/components/ActivityView.tsx'
const mutation = process.env.AGENTMUX_ACTIVITY_LAYOUT_MUTATION ?? null
export default defineConfig({ ...base,
  resolve: { ...base.resolve, alias: [candidateAlias(root, { source: true, browser: true }),
    ...(Array.isArray(base.resolve?.alias) ? base.resolve.alias : [])] },
  plugins: [...base.plugins ?? [], {
  name: 'original-activity-layout-owner', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file), path = relative(root, actual)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    let loaded = source, applied: string | null = null
    if (path === owner && mutation) {
      const before = 'if (followRef.current.following || atLoadedTail) syncTailPosition()'
      if (source.split(before).length !== 2) throw new Error('Missing exact original layout-tail gate')
      const after = mutation === 'measure-detached-layout' ? 'syncTailPosition()'
        : mutation === 'skip-detached-tail-transition' ? 'if (followRef.current.following) syncTailPosition()' : null
      if (!after) throw new Error('Unknown original layout-tail mutation')
      loaded = source.replace(before, after); applied = mutation
    }
    if (process.env.AGENTMUX_ACTIVITY_LAYOUT_LOADED) {
      const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_ACTIVITY_LAYOUT_LOADED, JSON.stringify({ path,
        fileSHA256: sha(readFileSync(actual)), originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: applied }) + '\n')
    }
    return loaded
  }
}], test: { ...base.test, include: ['apps/desktop/test/activity-content-layout-cost.test.tsx'] } })
