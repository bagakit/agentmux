import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import shared from '../focus-card-identity/vitest.owning.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...shared, cacheDir: resolve(root, '.tmp/focus-hover-refinement/vitest-cache'),
  plugins: [...shared.plugins ?? [], { name: 'actual-focus-hover-density', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['apps/desktop/src/renderer/src/components/AgentInformationPreview.tsx', 'apps/desktop/src/renderer/src/components/WorkbenchTopology.tsx'].includes(path)) return
    const needle = '<WorkbenchTabGlyph tab={tab} />'
    let served = code
    if (process.env.AGENTMUX_HOVER_MUTATION && path.endsWith('AgentInformationPreview.tsx')) {
      if (code.split(needle).length !== 2) throw Error('One exact original Hover glyph consumer required')
      served = code.replace(needle, '<WorkbenchTabGlyph tab={{ ...tab, highlightedRegionIds: [] }} />')
    }
    if (process.env.AGENTMUX_HOVER_LOADED) appendFileSync(process.env.AGENTMUX_HOVER_LOADED, JSON.stringify({ path,
      sourceSha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
      servedSha256: createHash('sha256').update(served).digest('hex'), mutated: served !== code }) + '\n')
    return served !== code ? { code: served, map: null } : undefined
  } }],
  test: { ...shared.test, include: ['apps/desktop/test/focus-hover-density.test.tsx', 'apps/desktop/test/focus-workbench-identity.test.tsx',
    'apps/desktop/test/focus-context-hover-inputs.test.tsx', 'apps/desktop/test/focus-hover-reading-quality.test.tsx', 'apps/desktop/test/focus-card-state.test.tsx'], passWithNoTests: false }
})
