import { Switch } from '@agentmux/client-ui/input'
import { channelHeaderChoice } from '../../../../shared/channel-presentation'
import { useAppStore } from '../../store'
import { useSettingDraftRecord } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { saveChannelHeader } from '../../lib/channel-header-config'

/** App presentation uses ConfigOwner; this control cannot change Host traffic policy. */
export function ChannelHeaderControl({ platform }: { platform: { adapterId: string; title: string } }) {
  const config = useAppStore(state => state.config)
  const draft = useSettingDraftRecord({ visible: channelHeaderChoice(config?.appearance.channelHeaderVisibility, platform.adapterId) })
  const save = useSettingsSave()
  async function submit() {
    const submitted = draft.beginSave()
    const committed = await save.run(async () => {
      await saveChannelHeader({ adapterId: platform.adapterId, visible: submitted.value.visible, expected: submitted.expected.visible })
    })
    submitted.finish(committed)
  }
  return <section className="channel-header-control" aria-label={`${platform.title} display`}>
    <label><span><strong>Show in Agent header</strong><small>This App only. Hiding the icon keeps messages running.</small></span>
      <Switch aria-label={`Show ${platform.title} in Agent header`} checked={draft.value.visible !== false} onChange={event => draft.setField('visible', event.target.checked)} /></label>
    {draft.dirty || save.state !== 'idle' ? <SettingsSaveBar save={save} dirty={draft.dirty} resolution={draft} blocked={config ? undefined : 'app settings are still loading.'} label="Save display" onSave={() => void submit()} /> : null}
  </section>
}
