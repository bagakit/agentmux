import { useEffect, useState, type CSSProperties } from 'react'
import type { AppConfig, NotificationModeId } from '../../../../shared/contracts'
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
  onSave: (notifications: NonNullable<AppConfig['notifications']>) => Promise<void>
}) {
  const [mode, setMode] = useState<NotificationModeId>(resolveNotificationModeId({ notifications }))
  // A second, independent dimension — not a sixth stop on the dwell slider. The slider answers "how
  // long does it stay"; this answers "do I hear it". Either is a coherent choice at any setting of the
  // other, which is exactly why folding them into one control would force a false ordering.
  const [sound, setSound] = useState(resolveNotificationSound({ notifications }))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setMode(resolveNotificationModeId({ notifications }))
    setSound(resolveNotificationSound({ notifications }))
  }, [notifications])

  const index = NOTIFICATION_TIERS.findIndex((tier) => tier.id === mode)
  const active = NOTIFICATION_TIERS[index] ?? NOTIFICATION_TIERS[0]!
  const savedMode = resolveNotificationModeId({ notifications })
  const savedSound = resolveNotificationSound({ notifications })
  // `off` raises nothing at all, so a sound choice under it has nothing to apply to. The control stays
  // visible and disabled rather than disappearing: a toggle that vanishes reads as a feature that was
  // removed, and the user needs to see that turning the slider up is what re-enables it.
  const soundApplies = mode !== 'off'

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
    setSaving(true)
    try {
      await onSave({ mode, sound })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <p className="settings-lead">When an Agent finishes, needs you, or fails while you are looking elsewhere, AgentMux raises a system notification naming the Agent, its state, and the latest exchange.</p>
      <figure className="notification-preview" aria-label="Notification preview">
        <div className="notification-preview__chrome"><b>AgentMux</b><time>now</time></div>
        <div className="notification-preview__title">
          <span className="status status--waiting" aria-hidden="true"><span className="status__dot" /></span>
          Review Codex — Needs you
        </div>
        <p className="notification-preview__body">Review Codex: Ready for your call on the migration plan.</p>
        <div className="notification-preview__dwell" data-persist={persist ? 'true' : undefined} style={{ '--dwell-fill': dwellFill } as CSSProperties}><i /></div>
      </figure>
      <section className="settings-group">
        <header><span>How long it stays</span><small>{active.label}</small></header>
        <div className="notification-dwell">
          <input
            className="notification-dwell__slider"
            type="range"
            min={0}
            max={NOTIFICATION_TIERS.length - 1}
            step={1}
            value={index < 0 ? 0 : index}
            aria-label="Notification dwell"
            aria-valuetext={active.label}
            onChange={(event) => setMode(NOTIFICATION_TIERS[Number(event.target.value)]!.id)}
          />
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
      <section className="settings-group">
        <header><span>Sound</span><small>{sound ? 'On' : 'Off'}</small></header>
        <label className="notification-sound-toggle">
          <input
            type="checkbox"
            checked={sound}
            disabled={!soundApplies}
            onChange={(event) => setSound(event.target.checked)}
          />
          <span>
            <strong>Play the system notification sound</strong>
            <small>Off by default — a banner you can see but not hear. Turn it on when you are away from the screen and an Agent finishing or getting stuck is worth looking up for. The sound is the one your OS uses for notifications; AgentMux does not ship its own.{soundApplies ? '' : ' Unavailable while notifications are off.'}</small>
          </span>
        </label>
      </section>
      <div className="settings-pane-actions">
        <span>“Until I dismiss it” asks the platform to keep the notification up; where it cannot, it is shown as a normal banner and AgentMux says so.</span>
        <button className="primary-button" disabled={saving || (mode === savedMode && sound === savedSound)} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save notifications'}
        </button>
      </div>
    </div>
  )
}
