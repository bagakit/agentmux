import { api } from '../../lib/api'
import type { SettingsPaneProps } from './settings-catalog'
import { HostTailcatListenerFields } from './HostTailcatListenerFields'
import { useTailcatConnectionDrafts } from './use-tailcat-connection-drafts'
import { useSettingsSave, SettingsSaveBar } from './SettingsSaveBar'

/** The sole local listener editor; retained while its Node panel is hidden. */
export function LocalIncomingConnections({ config, active }: Pick<SettingsPaneProps, 'config' | 'active'>) {
  const local = config.hosts.find(host => host.kind === 'local')
  const listener = useTailcatConnectionDrafts(Object.fromEntries(local ? [[local.id, local]] : []), 'incoming'), listenerSave = useSettingsSave()
  const localDraft = local ? listener.value[local.id] : undefined
  async function saveListener() {
    if (!local || localDraft?.kind !== 'local') return
    const submitted = listener.beginSave(), next = localDraft.tailcat, expectedHost = listener.expected[local.id]
    const expected = expectedHost?.kind === 'local' ? expectedHost.tailcat : undefined
    const ok = await listenerSave.run(async () => {
      await api.hosts.configureTailcat({ hostId: 'local', expected: expected ?? null, candidate: next ?? null })
    })
    submitted.finish(ok ? submitted.value : undefined)
  }
  if (!local || localDraft?.kind !== 'local') return null
  return <section className="host-local-incoming" data-settings-field="incoming" data-settings-host={local.id}>
    <p className="field-hint">Connection keys allow access to the service. Agent creation and message trust are managed separately.</p>
    {listener.retained}
    <HostTailcatListenerFields allowedClientsText={listener.allowedText[local.id]} onAllowedClientsTextChange={text => listener.setAllowedText(local.id, text)}
      host={localDraft} committed={local} active={active} saveLabel="Save incoming connections"
      onChange={tailcat => listener.setValue(current => ({ ...current, [local.id]: { ...localDraft, tailcat } }))} />
    <SettingsSaveBar save={listenerSave} dirty={listener.dirty} resolution={listener} scopeLabel="Incoming connections" label="Save incoming connections" onSave={() => void saveListener()} />
  </section>
}
