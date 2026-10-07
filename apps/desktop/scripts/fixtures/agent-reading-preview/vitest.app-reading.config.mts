import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import shared from '../focus-goal-access/vitest.owning.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...shared, plugins: [...shared.plugins ?? [], {
  name: 'actual-window-agent-reader', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/')) return
    let served = code
    if (process.env.AGENT_READING_APP_MUTATION && path === 'apps/desktop/src/renderer/src/App.tsx') {
      const needle = '<WindowOverlayHost><AgentInformationPreviewHost /></WindowOverlayHost>'
      if (code.split(needle).length !== 2) throw Error('One actual window reader owner required')
      served = code.replace(needle, '<WindowOverlayHost />')
    }
    if (process.env.AGENT_READING_APP_LOADED) appendFileSync(process.env.AGENT_READING_APP_LOADED, JSON.stringify({ path,
      sourceSha256: createHash('sha256').update(code).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), mutated: code !== served }) + '\n')
    return served !== code ? { code: served, map: null } : undefined
  }
}], test: { ...shared.test, include: ['apps/desktop/test/focus-surface-residency.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
