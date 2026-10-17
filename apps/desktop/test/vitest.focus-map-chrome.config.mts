import { defineConfig } from 'vitest/config'
import base from './vitest.performance-reading.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

export const focusMapChromeMutations = [
  { name: 'map-owned-chrome', before: "const focusMap = mainSurface === 'agents' && focusView === 'map'", after: 'const focusMap = false', assertion: 'keeps native window inset without reserving a Space sidebar for any remembered preference' },
  { name: 'map-sidebar-control', before: "if (mainSurface === 'agents' && focusView === 'map') return null", after: '', assertion: 'does not expose a Space toggle through the shared compact-window chrome' },
  { name: 'map-space-navigation', before: 'onCloseSettings?.(); setMainSurface(plugin.surface)', after: "onCloseSettings?.(); if (!(useAppStore.getState().mainSurface === 'agents' && useAppStore.getState().focusView === 'map' && plugin.surface === 'workbench')) setMainSurface(plugin.surface)", assertion: 'retains Focus List and Map owners, exact original workface and input across actual App navigation' }
] as const
const selected = process.env.AGENTMUX_FOCUS_MAP_CHROME_MUTATION
const mutation = focusMapChromeMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown Focus Map chrome mutation')
const scope = process.env.AGENTMUX_FOCUS_MAP_CHROME_SCOPE
if (scope && scope !== 'app') throw Error('Unknown Focus Map chrome test scope')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
let loaded = false
export default defineConfig({ ...base, cacheDir: '.cache/focus-map-chrome', plugins: [...base.plugins!, {
  name: 'focus-map-chrome-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (path !== 'apps/desktop/src/renderer/src/components/TopRowChrome.tsx') return
    let code = source
    if (mutation) {
      if (code.split(mutation.before).length !== 2) throw Error('Unique Focus Map chrome mutation anchor required')
      code = code.replace(mutation.before, mutation.after)
    }
    loaded = true
    if (process.env.AGENTMUX_FOCUS_MAP_CHROME_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_MAP_CHROME_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutant: selected ?? null }) + '\n')
    if (code !== source) return { code, map: null }
  }, buildEnd() { if (!loaded) throw Error('The actual Focus Map chrome source must be loaded') }
}], test: { ...base.test, environment: 'happy-dom', maxWorkers: 1,
  include: scope === 'app' ? ['apps/desktop/test/desktop-focus-navigation.test.tsx']
    : ['apps/desktop/test/focus-map-chrome.test.tsx', 'apps/desktop/test/goals-chrome-surface.test.tsx'] } })
