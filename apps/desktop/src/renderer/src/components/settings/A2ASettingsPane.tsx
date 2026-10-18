import { useId } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { A2A_NOTIFICATION_IDS, a2aNotificationPresentation, type A2ANotificationPreference } from '../../../../shared/a2a-preferences'
import { NOTIFICATION_TIERS, type NotificationSettings } from '../../../../shared/notification-presentation'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import './a2a-settings.css'

const choices = {
  'follow-global': ['Follow global', 'Use the banner and sound preferences in Notifications.'],
  silent: ['Silent', 'Keep messages in the mailbox without a system banner.'],
  notify: ['Notify', 'Show banners even when global notifications are off.']
} as const

export function A2ASettingsPane({ notifications, globalNotifications, onSave, onOpenNotifications }: {
  notifications: A2ANotificationPreference
  globalNotifications?: NotificationSettings
  onOpenNotifications?: () => void
  onSave(value: A2ANotificationPreference, expected: A2ANotificationPreference): Promise<void>
}) {
  const draft = useSettingDraft(notifications), save = useSettingsSave(), group = useId()
  const presentation = a2aNotificationPresentation({ a2a: { notifications: draft.value }, ...(globalNotifications ? { notifications: globalNotifications } : {}) })
  const tier = NOTIFICATION_TIERS.find(item => item.id === (presentation?.mode ?? 'off'))!
  async function persist() {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(() => onSave(submitted.value, submitted.expected)))
  }
  return <div className="settings-pane-stack" data-a2a-settings>
    <p className="a2a-settings__scope">Choose how Agent messages notify you when the receiving Agent is in the background.</p>
    <section className="settings-group" data-settings-field="a2a-notifications">
      <header><span>Incoming message notifications</span><small>Saved: {choices[notifications][0]}</small></header>
      <div className="a2a-settings__choice-preview">
      <fieldset className="settings-reading-width">
        <legend>System banners</legend>
        {A2A_NOTIFICATION_IDS.map(value => <label key={value} data-selected={draft.value === value}>
          <input type="radio" name={group} value={value} checked={draft.value === value} onChange={() => draft.setValue(value)} />
          <span><strong>{choices[value][0]}</strong><small>{choices[value][1]}</small></span>
        </label>)}
      </fieldset>
      <figure className="a2a-settings__preview" aria-label="A2A notification preview" data-a2a-preview={tier.id}>
        <figcaption><span>Background message</span><span>{draft.dirty ? 'Unsaved preview' : 'Saved settings'}</span></figcaption>
        <div className="a2a-settings__message"><SemanticIcon name="object.inbox" size={20} aria-hidden="true" /><div><strong>Research → Review</strong><p>The findings are ready for your review.</p><small>Example message · kept in the mailbox</small></div></div>
        <div className="a2a-settings__outcome">
          <strong>{presentation ? `${tier.label} banner` : 'No system banner'}</strong>
          <span>{presentation ? `Sound ${presentation.sound ? 'on' : 'off'}` : 'Mailbox only'}</span>
          <p>{tier.description}</p>
        </div>
        <p className="a2a-settings__preview-note">{presentation ? 'Duration is a request to your system; actual presentation may vary.' : 'Messages remain available to the receiving Agent.'}</p>
      </figure>
      </div>
      {onOpenNotifications && <div className="a2a-settings__global"><span>Review global banner duration and sound.</span><button type="button" className="small-button" onClick={onOpenNotifications}>Open Notifications</button></div>}
    </section>
    <p className="a2a-settings__scope">Agents still receive message references at a confirmed idle opportunity and read original messages by ID. A banner does not mark a message read or accepted.</p>
    <SettingsSaveBar save={save} dirty={draft.dirty} label="Save A2A notifications" onSave={() => void persist()} />
  </div>
}
