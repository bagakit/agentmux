import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
const evidence = process.env.AGENTMUX_MESH_UI_EVIDENCE ?? resolve(root, '.local/state/mesh-network-access/ui-tests')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_MESH_UI_MUTANT
process.env.AGENTMUX_RESOURCE_LIBRARY_SECTION = 'hosts'
process.env.AGENTMUX_FOCUS_IDENTITY_SLICE = 'mote-avatar'
const edits: Record<string, [string, string, string]> = {
  'foreign-observation': ['renderer/src/components/settings/MeshNetworkSettings.tsx', 'const snapshot = networkSnapshot && (!settings || networkSnapshot.owner.runtimeId === settings.owner.runtimeId && networkSnapshot.owner.ownerInstanceId === settings.owner.ownerInstanceId) ? networkSnapshot : undefined', 'const snapshot = networkSnapshot'],
  'overwrite-listener': ['renderer/src/components/settings/MeshNetworkSettings.tsx', "onClick={() => change({ role: 'gateway' })}", "onClick={() => change({ role: 'gateway', listen: true })}"],
  'lost-independent-read': ['renderer/src/components/settings/MeshNetworkSettings.tsx', '    // Network observation and editable settings are independent capabilities.\n    void inspectNetwork(controller.signal)', ''],
  'invented-empty-network': ['renderer/src/components/settings/MeshNetworkSettings.tsx', '{hasTopology ? <MeshNetworkMap', '{true ? <MeshNetworkMap'],
  'lost-fence': ['main/mesh-network-ipc.ts', '...(original ? { runtimeFence: original } : {})', ''],
  'lost-draft': ['renderer/src/components/settings/MeshNetworkSettings.tsx', 'form: later ? value.form : meshForm(result.settings.configuration, result.settings.identity?.peerId)', 'form: meshForm(result.settings.configuration, result.settings.identity?.peerId)'],
  'lost-unknown': ['renderer/src/components/settings/MeshNetworkSettings.tsx', "if (!notApplied) return { ...value, pending: { ...value.pending, phase: 'unknown' } }", 'if (false) return value'],
  'wrong-method': ['renderer/src/lib/mesh-network-client.ts', 'preload.call(method, params,', "preload.call('mesh.inspect' as typeof method, params,"],
  'relocation': ['renderer/src/components/settings/HostSettingsPane.tsx', '          <LocalIncomingConnections config={config} active={localConnectionVisible} visible={localConnectionVisible} />', ''],
  'local-only-visibility': ['renderer/src/components/settings/HostSettingsPane.tsx', 'visible={localConnectionVisible} />', "visible={active && view === 'editor'} />"],
  'incoming-scope': ['renderer/src/components/settings/LocalIncomingConnections.tsx', 'onAllowedClientsTextChange={text => listener.setAllowedText(local.id, text)}', "onAllowedClientsTextChange={text => listener.setAllowedText('hosts', text)}"],
  'independent-save': ['renderer/src/components/settings/LocalIncomingConnections.tsx', "await api.hosts.configureTailcat({ hostId: 'local', expected: expected ?? null, candidate: next ?? null })", 'await Promise.resolve()'],
  'active-removal': ['renderer/src/components/settings/HostTailcatListenerFields.tsx', '<TailcatKeyPreparation active={active} host={host}', '<TailcatKeyPreparation host={host}'],
  'readActive-removal': ['renderer/src/components/MoteActionChooser.tsx', 'visible={active} readActive={active}', 'visible={active}'],
  'static-preserve': ['renderer/src/components/SpaceObjectIcon.tsx', 'active={readActive}', 'active={visible !== false}'],
  'rejected-entry-retained': ['renderer/src/components/SpaceObjectIcon.tsx', 'void entry.promise.catch(() => { if (activeMoteAvatarReads.get(key) === entry) activeMoteAvatarReads.delete(key) })', 'void entry.promise.catch(() => { if (entry.consumers === 0 && activeMoteAvatarReads.get(key) === entry) activeMoteAvatarReads.delete(key) })'],
}
if (mutant && !edits[mutant]) throw Error('Unknown Mesh UI mutant')
const targetedIncludes: Record<string, string[]> = {
  'lost-fence': ['apps/desktop/test/mesh-network-ipc.test.ts'], 'wrong-method': ['apps/desktop/test/mesh-network-ipc.test.ts'],
  'lost-draft': ['apps/desktop/test/mesh-settings.test.tsx'], 'lost-unknown': ['apps/desktop/test/mesh-settings.test.tsx'],
  relocation: ['apps/desktop/test/host-tailcat-settings.test.tsx', 'apps/desktop/test/tailcat-connection-draft.test.tsx'],
  'local-only-visibility': ['apps/desktop/test/host-tailcat-settings.test.tsx', 'apps/desktop/test/tailcat-connection-draft.test.tsx'],
  'incoming-scope': ['apps/desktop/test/host-tailcat-settings.test.tsx', 'apps/desktop/test/tailcat-connection-draft.test.tsx'],
  'independent-save': ['apps/desktop/test/host-tailcat-settings.test.tsx', 'apps/desktop/test/tailcat-connection-draft.test.tsx'],
  'active-removal': ['apps/desktop/test/tailcat-connection-draft.test.tsx'],
  'readActive-removal': ['apps/desktop/test/tailcat-connection-draft.test.tsx'],
  'static-preserve': ['apps/desktop/test/focus-timeline-identity.test.tsx'],
  'rejected-entry-retained': ['apps/desktop/test/mote-avatar-read-retry.test.tsx'],
}
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases }, plugins: [{ name: 'mesh-ui-consumed', enforce: 'pre', resolveId: installedDependency,
  transform(input, id) {
    if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?') || !/\.[cm]?[jt]sx?$/u.test(id)) return
    const path = relative(root, id), sha = (text: string) => createHash('sha256').update(text).digest('hex')
    appendFileSync(resolve(evidence, 'consumed.jsonl'), JSON.stringify({ path, sha256: sha(input) }) + '\n')
    if (!mutant || !id.endsWith('/src/' + edits[mutant]![0])) return
    const [, from, to] = edits[mutant]!
    if (input.split(from).length !== 2) throw Error('Mutation must bind once in actual loaded product source')
    const output = input.replace(from, to)
    appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, path, before: sha(input), after: sha(output) }) + '\n')
    return { code: output, map: null }
  } }], test: { include: mutant ? targetedIncludes[mutant]! : ['apps/desktop/test/mesh-settings.test.tsx', 'apps/desktop/test/mesh-network-ipc.test.ts', 'apps/desktop/test/host-settings-navigation.test.tsx', 'apps/desktop/test/settings-host-disclosure.test.tsx', 'apps/desktop/test/settings-section-routing.test.tsx', 'apps/desktop/test/host-tailcat-settings.test.tsx', 'apps/desktop/test/host-tailcat-pairing.test.tsx', 'apps/desktop/test/tailcat-connection-draft.test.tsx', 'apps/desktop/test/settings-save-feedback.test.tsx', 'apps/desktop/test/settings-connections.test.tsx', 'apps/desktop/test/settings-resource-library.test.tsx', 'apps/desktop/test/node-owner-target.test.tsx', 'apps/desktop/test/tailcat-mote-assistance.test.tsx', 'apps/desktop/test/settings-close-continuity.test.tsx', 'apps/desktop/test/network-node-settings.test.tsx', 'apps/desktop/test/node-publication-navigation.test.tsx', 'apps/desktop/test/host-tailcat-settings-product.test.tsx', 'apps/desktop/test/settings-tailcat-listener-cli.test.ts', 'packages/core/test/tailcat-key-rpc.test.ts', 'apps/desktop/test/focus-timeline-identity.test.tsx', 'apps/desktop/test/mote-avatar-read-retry.test.tsx'], environment: 'node', pool: 'forks', maxWorkers: 1, fileParallelism: false, testTimeout: 90000, hookTimeout: 90000 } })
