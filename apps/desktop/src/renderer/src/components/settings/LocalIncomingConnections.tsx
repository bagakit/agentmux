import { api } from '../../lib/api'
import type { SettingsPaneProps } from './settings-catalog'
import { HostTailcatListenerFields } from './HostTailcatListenerFields'
import { useTailcatConnectionDrafts } from './use-tailcat-connection-drafts'
import { useSettingsSave, SettingsSaveBar } from './SettingsSaveBar'

/** The sole local listener editor; retained while its Host Connection is hidden. */
export function LocalIncomingConnections({ config, active, visible }: Pick<SettingsPaneProps, 'config' | 'active'> & { visible: boolean }) {
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
  return <section className="host-local-incoming" data-settings-field="incoming" hidden={!visible} inert={!visible}>
    <header><div><h3>Incoming connections</h3><p>Let an approved client reach this running service. Connection keys do not grant Agent creation or message trust.</p></div></header>
    {listener.retained}
    <HostTailcatListenerFields allowedClientsText={listener.allowedText[local.id]} onAllowedClientsTextChange={text => listener.setAllowedText(local.id, text)}
      host={localDraft} committed={local} active={active && visible} saveLabel="Save incoming connections"
      onChange={tailcat => listener.setValue(current => ({ ...current, [local.id]: { ...localDraft, tailcat } }))} />
    <SettingsSaveBar save={listenerSave} dirty={listener.dirty} resolution={listener} scopeLabel="Incoming connections" label="Save incoming connections" onSave={() => void saveListener()} />
  </section>
}
