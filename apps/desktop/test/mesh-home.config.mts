import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const evidence = resolve(process.env.AGENTMUX_MESH_HOME_EVIDENCE ?? '.local/state/mesh-home-redesign/home-tests')
mkdirSync(evidence, { recursive: true })
process.env.AGENTMUX_RESOURCE_LIBRARY_SECTION = 'hosts'
const mutant = process.env.AGENTMUX_MESH_HOME_MUTANT
const mutations: Record<string, [string, string, string]> = {
  'wrong-home': ['MeshSettingsPane.tsx', "request?.field?.startsWith('mesh-') ? 'network' : 'paths'", "request?.field?.startsWith('mesh-') ? 'network' : 'network'"],
  'wrong-host': ['MeshSettingsPane.tsx', 'onConnections={openConnection}', 'onConnections={() => openConnection(props.config.hosts[0]!.id)}'],
  'unmount-editor': ['MeshSettingsPane.tsx', "mounted('connections') ? <HostSettingsPane", "view === 'connections' ? <HostSettingsPane"],
  'duplicate-add': ['HostSettingsPane.tsx', ' || appliedAddRequest.current === addHostRequest.intentId', ''],
  'filter-all': ['ClusterMachinesPane.tsx', 'fields.some(field => field.toLocaleLowerCase().includes(needle))', 'true'],
  'empty-saved-map': ['MeshNetworkMap.tsx', "...savedNodes.filter(node => node.type !== 'savedClient' || !sharedPeerId)", '...[]'],
  'hide-saved-on-relay': ['MeshNetworkMap.tsx', 'const savedNodes = savedConnectionNodes(hosts,', 'const savedNodes = savedConnectionNodes(hasRelayPeers ? NO_HOSTS : hosts,'],
  'separate-local-origins': ['MeshNetworkMap.tsx', 'const sharedPeerId = localClient && (hosts.length || localPlaced) ? model.peers.find(peer => peer.own)?.id : undefined', 'const sharedPeerId = undefined'],
  'guess-local-peer': ['MeshNetworkMap.tsx', 'model.peers.find(peer => peer.own)?.id', 'model.peers[0]?.id'],
  'hide-saved-on-focus': ['MeshNetworkMap.tsx', 'const savedNodes = savedConnectionNodes(hosts,', 'const savedNodes = savedConnectionNodes(focused ? NO_HOSTS : hosts,'],
  'borrowed-map-outline': ['MeshNetworkMap.tsx', '{geography ? <MeshGeography {...geography} /> : null}', '{geography ? <MeshGeography {...geography} /> : <div className="mesh-geography__atlas" />}'],
  'flat-location-projection': ['MeshGeography.tsx', '(90 - latitude) * WORLD_HEIGHT / 180', 'WORLD_HEIGHT / 2'],
  'mirrored-location-picker': ['MeshGeography.tsx', 'longitude: x * 360 / WORLD_WIDTH - 180', 'longitude: 180 - x * 360 / WORLD_WIDTH'],
  'wrong-map-device': ['MeshSavedConnections.tsx', 'onClick={() => onDevice(host.id)}', 'onClick={() => onDevice("selected-farm")}'],
  'hidden-machines': ['MeshSettingsPane.tsx', "mounted('paths') || mounted('machines')", "view === 'machines'"],
  'hidden-saved-gateways': ['MeshPathsPane.tsx', 'savedTargets={savedTargets}', 'savedTargets={undefined}'],
  'stale-add-after-navigation': ['MeshSettingsPane.tsx', 'function supersedeAdd() { setAddHostRequest(undefined) }', 'function supersedeAdd() {}'],
}
if (mutant && !mutations[mutant]) throw Error('Unknown Mesh homepage mutant')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases }, plugins: [{ name: 'mesh-home-consumed', enforce: 'pre', resolveId: installedDependency,
  transform(input, id) {
    if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?') || !/\.[cm]?[jt]sx?$/u.test(id)) return
    const path = relative(root, id), sha = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(resolve(evidence, 'consumed.jsonl'), JSON.stringify({ path, sha256: sha(input) }) + '\n')
    if (!mutant || !id.endsWith('/settings/' + mutations[mutant]![0])) return
    const [, from, to] = mutations[mutant]!
    if (input.split(from).length !== 2) throw Error('Homepage mutation must bind once in actual loaded source')
    let output = input.replace(from, to)
    if (mutant === 'stale-add-after-navigation') {
      const originalNavigation = 'addHostRequest={addHostNavigation.current === props.navigationRequest ? addHostRequest : undefined}'
      if (output.split(originalNavigation).length !== 2) throw Error('Original navigation Add boundary must bind once')
      output = output.replace(originalNavigation, 'addHostRequest={addHostRequest}')
    }
    appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, path, before: sha(input), after: sha(output) }) + '\n')
    return { code: output, map: null }
  } }], test: { include: ['apps/desktop/test/mesh-home.test.tsx'], environment: 'happy-dom', pool: 'forks', maxWorkers: 1, fileParallelism: false, testTimeout: 90000, hookTimeout: 90000, passWithNoTests: false } })
