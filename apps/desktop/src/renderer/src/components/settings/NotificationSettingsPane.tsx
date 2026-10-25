import './notification-settings.css'
import { FormRow } from '@agentmux/client-ui/components/FormRow'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useId, type CSSProperties } from 'react'
import type { AppConfig, NotificationModeId } from '../../../../shared/contracts'
import { useSettingDraft } from './use-setting-draft'
import {
  NOTIFICATION_TIERS,
  resolveNotificationModeId,
  resolveNotificationSound
} from '../../../../shared/notification-presentation'

// The dwell control is ONE slider on ONE dimension: off → several dwell durations → until-acknowledged.
// The stops come straight from NOTIFICATION_TIERS (the same table delivery reads), so the control and
// the notifier can never disagree about what a stop means. A single <input type="range"> — not a switch
// plus a number field — is what "一个控件而不是开关加输入框" asks for.
export function NotificationSettingsPane({ notifications, onSave }: {
  notifications: AppConfig['notifications']
  onSave: (notifications: NonNullable<AppConfig['notifications']>, expected: NonNullable<AppConfig['notifications']>) => Promise<void>
}) {
  const stopsId = useId()
  const modeDraft = useSettingDraft<NotificationModeId>(resolveNotificationModeId({ notifications }))
  // A second, independent dimension — not a sixth stop on the dwell slider. The slider answers "how
  // long does it stay"; this answers "do I hear it". Either is a coherent choice at any setting of the
  // other, which is exactly why folding them into one control would force a false ordering.
  const soundDraft = useSettingDraft(resolveNotificationSound({ notifications }))
  const mode = modeDraft.value, setMode = modeDraft.setValue
  const sound = soundDraft.value, setSound = soundDraft.setValue
  const saveState = useSettingsSave()

  const index = NOTIFICATION_TIERS.findIndex((tier) => tier.id === mode)
  const active = NOTIFICATION_TIERS[index] ?? NOTIFICATION_TIERS[0]!
  // The preview mirrors the terminal-theme swatch: it draws the real thing the control shapes. The
  // dwell meter fills in proportion to how long the banner stays — off collapses it, "until I dismiss"
  // fills it and breathes. The longest bounded dwell anchors the scale so the fill reads as a ratio.
  const longestDwellMs = Math.max(
    ...NOTIFICATION_TIERS.map((tier) => (tier.mode.kind === 'dwell' ? tier.mode.dwellMs : 0))
  )
  const persist = active.mode.kind === 'until-acknowledged'
  const dwellFill = persist
    ? '100%'
    : active.mode.kind === 'dwell'
      ? `${Math.round((active.mode.dwellMs / longestDwellMs) * 100)}%`
      : '0%'

  async function save(): Promise<void> {
    const submittedMode = modeDraft.beginSave(), submittedSound = soundDraft.beginSave()
    const committed = await saveState.run(() => onSave(
      { mode: submittedMode.value, sound: submittedSound.value },
      { mode: submittedMode.expected, sound: submittedSound.expected }
    ))
    submittedMode.finish(committed)
    submittedSound.finish(committed)
  }

  return (
    <div className="settings-pane-stack settings-notifications">
      <p className="settings-hint">Desktop banners appear outside AgentMux when a background Agent finishes, needs your input or fails. These settings control their duration and sound. Current issues in the notification center and requests in Focus stay available when banners are off. Agent message alerts follow your A2A preference.</p>
      <figure className="notification-preview" aria-label="Desktop banner preview" data-notification-mode={mode}>
        <figcaption><span>Example desktop banner</span><span>{modeDraft.dirty || soundDraft.dirty ? 'Unsaved preview' : 'Saved settings'}</span></figcaption>
        <div className="notification-preview__sample">
        <div className="notification-preview__chrome"><b>AgentMux</b><span>{mode === 'off' ? 'Agent status banners off' : active.label}</span></div>
        <div className="notification-preview__title">
          <span className="status status--waiting" aria-hidden="true"><span className="status__dot" /></span>
          Review Agent — Needs you
        </div>
        <p className="notification-preview__body">Review Agent: Ready for your call on the migration plan.</p>
        <div className="notification-preview__dwell" data-persist={persist ? 'true' : undefined} style={{ '--dwell-fill': dwellFill } as CSSProperties}><i /></div>
        </div>
        <p className="notification-preview__context">{mode === 'off' ? 'Agent status banners are off. Current issues and Focus requests remain available in AgentMux.' : 'When an agent finishes, needs you or runs into trouble while you are elsewhere.'}</p>
      </figure>
      <section className="settings-group" data-settings-field="notification-dwell">
        <header><span>Desktop banner duration</span><small>{active.label}</small></header>
        <div className="notification-dwell" style={{ '--notification-stops': NOTIFICATION_TIERS.length } as CSSProperties}>
          <input
            className="notification-dwell__slider"
            type="range"
            min={0}
            max={NOTIFICATION_TIERS.length - 1}
            step={1}
            value={index < 0 ? 0 : index}
            aria-label="Desktop banner duration"
            aria-valuetext={active.label}
            list={stopsId}
            onChange={(event) => setMode(NOTIFICATION_TIERS[Number(event.target.value)]!.id)}
          />
          <datalist id={stopsId}>{NOTIFICATION_TIERS.map((tier, index) => <option key={tier.id} value={index} label={tier.label} />)}</datalist>
          <ol className="notification-dwell__ticks" aria-hidden="true">
            {NOTIFICATION_TIERS.map((tier) => (
              <li
                key={tier.id}
                className="notification-dwell__tick"
                data-selected={tier.id === mode ? '' : undefined}
              >
                {tier.label}
              </li>
            ))}
          </ol>
          <p className="notification-dwell__description">{active.description}</p>
        </div>
      </section>
      <section className="settings-group" data-settings-field="notification-sound">
        <header><span>Sound</span><small>{sound ? 'On' : 'Off'}</small></header>
        <FormRow className="notification-sound-toggle" label="Play the system notification sound"
          description="Applies to Agent status banners and enabled A2A message alerts. Silent by default.">
          {attributes => <input
            {...attributes} type="checkbox" name="sound"
            checked={sound}
            onChange={(event) => setSound(event.target.checked)}
          />}
        </FormRow>
      </section>
      <SettingsSaveBar save={saveState} dirty={modeDraft.dirty || soundDraft.dirty} label="Save notifications" onSave={() => void save()} />
    </div>
  )
}
