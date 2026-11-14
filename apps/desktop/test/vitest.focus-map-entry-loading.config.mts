import base from './vitest.focus-editor-app-navigation.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'

const owner = 'apps/desktop/src/renderer/src/components/AgentCollaborationMapEntry.tsx'
const map = 'apps/desktop/src/renderer/src/components/AgentCollaborationMap.tsx'
const graph = 'apps/desktop/src/renderer/src/components/AgentCollaborationGraph.tsx'
const inverse = process.env.AGENTMUX_MAP_STARTUP_INVERSE
if (inverse && !['eager-map', 'drop-visited'].includes(inverse)) throw Error('Unknown Map entry inverse')
export default defineConfig({ ...base, cacheDir: '.tmp/focus-map-entry-loading-vitest', plugins: [{
  name: 'actual-map-module-entry', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (![owner, map, graph, 'apps/desktop/src/renderer/src/App.tsx'].includes(path)) return
    let code = source
    if (path === owner) {
      const before = "import('./AgentCollaborationMap')"
      if (code.split(before).length !== 2) throw Error('The original single Map import is required')
      code = code.replace(before, "((globalThis as any).__agentmuxMapEntryFixture.load(() => import('./AgentCollaborationMap')))")
    }
    if (path === map || path === graph) code += `\n;(globalThis as any).__agentmuxMapEntryFixture?.evaluated.push('${path === map ? 'Map' : 'Graph'}')\n`
    if (path.endsWith('/App.tsx') && inverse) {
      const before = inverse === 'eager-map' ? "from './components/AgentCollaborationMapEntry'" : 'mapVisited || mapVisible ? <AgentCollaborationMap'
      const after = inverse === 'eager-map' ? "from './components/AgentCollaborationMap'" : 'mapVisible ? <AgentCollaborationMap'
      if (code.split(before).length !== 2) throw Error('One original App Map entry is required')
      code = code.replace(before, after)
    }
    if (process.env.AGENTMUX_MAP_STARTUP_LOADED) appendFileSync(process.env.AGENTMUX_MAP_STARTUP_LOADED,
      JSON.stringify({ path, sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), inverse: inverse ?? null }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}, ...(base.plugins ?? [])], test: { ...base.test, include: ['apps/desktop/test/focus-map-entry-loading.test.tsx', 'apps/desktop/test/renderer-startup-graph.test.ts'], testTimeout: 20000 } })
