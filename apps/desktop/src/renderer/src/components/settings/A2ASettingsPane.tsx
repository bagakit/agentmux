import { useId } from 'react'
import { A2A_NOTIFICATION_IDS, type A2ANotificationPreference } from '../../../../shared/a2a-preferences'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import './a2a-settings.css'

const choices = {
  'follow-global': ['Follow global', 'Use Notifications for banners, duration and sound.'],
  silent: ['Silent', 'Keep incoming messages in the mailbox without a system banner.'],
  notify: ['Notify', 'Show a standard banner even when global notifications are off. Keep the global duration when enabled and always use its sound preference.']
} as const

export function A2ASettingsPane({ notifications, onSave }: {
  notifications: A2ANotificationPreference
  onSave(value: A2ANotificationPreference, expected: A2ANotificationPreference): Promise<void>
}) {
  const draft = useSettingDraft(notifications), save = useSettingsSave(), group = useId()
  async function persist() {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(() => onSave(submitted.value, submitted.expected)))
  }
  return <div className="settings-pane-stack" data-a2a-settings>
    <p className="settings-lead">Choose how incoming Agent messages get your attention while their recipient is in the background.</p>
    <section className="settings-group" data-settings-field="a2a-notifications">
      <header><span>Incoming message notifications</span><small>Saved: {choices[notifications][0]}</small></header>
      <fieldset className="settings-reading-width">
        <legend>System banners</legend>
        {A2A_NOTIFICATION_IDS.map(value => <label key={value} data-selected={draft.value === value}>
          <input type="radio" name={group} value={value} checked={draft.value === value} onChange={() => draft.setValue(value)} />
          <span><strong>{choices[value][0]}</strong><small>{choices[value][1]}</small></span>
        </label>)}
      </fieldset>
    </section>
    <p className="settings-footnote">Agents still receive message references at a confirmed idle opportunity and read original messages by ID. A banner does not mark a message read or accepted.</p>
    <SettingsSaveBar save={save} dirty={draft.dirty} label="Save A2A notifications" onSave={() => void persist()} />
  </div>
}
