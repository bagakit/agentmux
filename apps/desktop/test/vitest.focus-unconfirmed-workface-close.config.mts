import { defineConfig } from 'vitest/config'
import base from './vitest.workbench-close.config.mts'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const sources = 'apps/desktop/src/renderer/src/lib/use-focus-sources.tsx'
const mutations: Record<string, [string, string, string]> = {
  'reading-erases-source': ['apps/desktop/src/renderer/src/store.ts', 'mountedSpaceInputs: reconciled.mountedSpaceInputs ?? state.mountedSpaceInputs', 'mountedSpaceInputs: reconciled.mountedSpaceInputs'],
  'execution-gate': [sources, 'return confirmedOriginalRawLocations(state, target).filter(reference => {', "return confirmedOriginalRawLocations(state, target).filter(reference => ordinaryAgentSpaceMember({ tabId: reference.tabId, regionId: reference.regionId, sessionId: candidate.sid }).kind === 'foreign').filter(reference => {"],
  'nonlocal-collision': [sources, 'return confirmedOriginalRawLocations(state, target).filter(reference => {', 'return workbenchSelectionCatalog(state).locations.filter(reference => {'],
  'keep-intent': ['apps/desktop/src/renderer/src/hooks/useWorkbenchTabsClose.tsx', 'keepAgentSessions: request.keepAgentSessions === true', 'keepAgentSessions: false'],
  'stale-choice': [sources, 'reference && rawLocations(location).some(position =>', 'reference && [{ ...reference }].some(position =>']
}
const mutation = process.env.AGENTMUX_RAW_CLOSE_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known loaded close mutation')
const bound = new Set(Object.values(mutations).map(([file]) => file).concat(['apps/desktop/src/renderer/src/lib/workbench-close-request.ts']))
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/focus-unconfirmed-workface-close-' + (mutation ?? 'baseline')),
  plugins: [...base.plugins ?? [], { name: 'raw-focus-close-loaded-mutation', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!bound.has(path)) return
    let code = original
    if (mutation && path === mutations[mutation]![0]) { const [, from, to] = mutations[mutation]!; assert.equal(code.split(from).length - 1, 1, 'Unique actual product anchor'); code = code.replace(from, to) }
    if (process.env.AGENTMUX_RAW_CLOSE_LOADED) appendFileSync(process.env.AGENTMUX_RAW_CLOSE_LOADED, JSON.stringify({ path, mutation: code !== original ? mutation : null,
      originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    if (code !== original) return { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/focus-unconfirmed-workface-close.test.tsx'], setupFiles: [], globalSetup: [], testTimeout: 20000 } })
