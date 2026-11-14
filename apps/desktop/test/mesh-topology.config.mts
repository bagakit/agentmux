import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const evidence = resolve(process.env.AGENTMUX_MESH_TOPOLOGY_EVIDENCE ?? '.local/state/mesh-topology-interaction/tests')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_MESH_TOPOLOGY_MUTANT
const mutations: Record<string, [string, string, string]> = {
  'one-sided-link': ['mesh-topology.ts', 'other.epoch !== neighbor.peerEpoch || back.peerEpoch !== record.epoch || back.connectionId !== neighbor.connectionId || ', ''],
  'circuit-as-route': ['mesh-topology.ts', "if (selected?.kind === 'circuit') return model.circuits.find(circuit => circuit.circuitId === selected.id)?.path ?? []", "if (selected?.kind === 'circuit') return model.routes[0]?.path ?? []"],
  'foreign-selection': ['MeshNetworkMap.tsx', 'key={meshTopologySource(snapshot)}', 'key="shared-source"'],
  'poll-relayout': ['MeshNetworkMap.tsx', '[active, view, topologyKey, arrangeAttempt, fit, setNodes]', '[active, view, topologyKey, arrangeAttempt, fit, setNodes, snapshot]'],
  'lost-selection-fit': ['MeshNetworkMap.tsx', 'setFocusRequest(value => value + 1)', 'setFocusRequest(value => value)'],
  'poll-focus': ['MeshNetworkMap.tsx', 'focusRequest === focusedRequest.current', 'false'],
  'separate-list-inspector': ['MeshNetworkMap.tsx', "!onGateway || view === 'list' ? inspector : null", "!onGateway ? inspector : null"],
  'below-list-directory': ['MeshNetworkMap.tsx', "{view === 'list' ? directory : null}", '{null}'],
}
if (mutant && !mutations[mutant]) throw Error('Unknown Mesh topology mutant')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases }, plugins: [{ name: 'mesh-topology-consumed', enforce: 'pre', resolveId: installedDependency,
  transform(input, id) {
    if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?') || !/\.[cm]?[jt]sx?$/u.test(id)) return
    const path = relative(root, id), sha = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(resolve(evidence, 'consumed.jsonl'), JSON.stringify({ path, sha256: sha(input) }) + '\n')
    if (!mutant || !id.endsWith('/settings/' + mutations[mutant]![0])) return
    const [, from, to] = mutations[mutant]!
    if (input.split(from).length !== 2) throw Error('Topology mutation must bind once in actual loaded source')
    let output = input.replace(from, to)
    if (mutant === 'poll-relayout') {
      const guard = 'if (!force && ids.every(id => positions.current.has(id))) return'
      if (output.split(guard).length !== 2) throw Error('Poll relayout mutation guard must bind once')
      output = output.replace(guard, 'if (false) return')
    }
    if (mutant === 'poll-focus') {
      const dependencies = '[focusRequest, active, view, fit]'
      if (output.split(dependencies).length !== 2) throw Error('Poll focus mutation dependencies must bind once')
      output = output.replace(dependencies, '[focusRequest, active, view, fit, snapshot]')
    }
    if (mutant === 'below-list-directory') {
      const placement = "{!onGateway && view === 'topology' && model.peers.length > 0 ? directory : null}"
      if (output.split(placement).length !== 2) throw Error('List directory placement must bind once')
      output = output.replace(placement, '{directory}')
    }
    appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, path, before: sha(input), after: sha(output) }) + '\n')
    return { code: output, map: null }
  } }], test: { include: ['apps/desktop/test/mesh-topology.test.tsx'], environment: 'happy-dom', pool: 'forks', maxWorkers: 1, fileParallelism: false, testTimeout: 90000, hookTimeout: 90000, passWithNoTests: false } })
