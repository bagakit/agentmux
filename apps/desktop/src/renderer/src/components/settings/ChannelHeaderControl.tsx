import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import { useSettingDraft } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'

/** App presentation uses ConfigOwner; this control cannot change Host traffic policy. */
export function ChannelHeaderControl({ platform }: { platform: { adapterId: string; title: string } }) {
  const config = useAppStore(state => state.config)
  const draft = useSettingDraft(config?.appearance.channelHeaderVisibility?.[platform.adapterId] !== false)
  const save = useSettingsSave()
  async function submit() {
    const submitted = draft.beginSave()
    const committed = await save.run(async () => {
      const current = useAppStore.getState().config
      if (!current) throw new Error('App settings are not loaded. Your display choice is kept.')
      const apply = (visible: boolean) => ({ ...current, appearance: { ...current.appearance,
        channelHeaderVisibility: { ...current.appearance.channelHeaderVisibility, [platform.adapterId]: visible } } })
      const saved = await api.config.save(apply(submitted.value), apply(submitted.expected))
      if (useAppStore.getState().config === current) useAppStore.getState().setConfig(saved)
    })
    submitted.finish(committed)
  }
  return <section className="channel-header-control" aria-label={`${platform.title} display`}>
    <label><span><strong>Show in Agent header</strong><small>This App only. Hiding the icon keeps messages running.</small></span>
      <input type="checkbox" aria-label={`Show ${platform.title} in Agent header`} checked={draft.value} onChange={event => draft.setValue(event.target.checked)} /></label>
    {draft.dirty || save.state !== 'idle' ? <SettingsSaveBar save={save} dirty={draft.dirty} disabled={!config} label="Save display" onSave={() => void submit()} /> : null}
  </section>
}
