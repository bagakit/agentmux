import { Bell } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppConfig, NotificationModeId } from '../../../../shared/contracts'
import {
  NOTIFICATION_TIERS,
  resolveNotificationModeId
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
  const [saving, setSaving] = useState(false)

  useEffect(() => setMode(resolveNotificationModeId({ notifications })), [notifications])

  const index = NOTIFICATION_TIERS.findIndex((tier) => tier.id === mode)
  const active = NOTIFICATION_TIERS[index] ?? NOTIFICATION_TIERS[0]!
  const savedMode = resolveNotificationModeId({ notifications })

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await onSave({ mode })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <section className="settings-card settings-card--hero">
        <span className="settings-card__icon"><Bell size={18} /></span>
        <div>
          <h3>Attention notifications</h3>
          <p>When an Agent finishes, needs you, or fails while you are looking elsewhere, AgentMux raises a system notification naming the Agent, its state, and the latest exchange.</p>
        </div>
      </section>
      <section className="settings-group notification-dwell-group">
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
      <div className="settings-pane-actions">
        <span>“Until I dismiss it” asks the platform to keep the notification up; where it cannot, it is shown as a normal banner and AgentMux says so.</span>
        <button className="primary-button" disabled={saving || mode === savedMode} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save notifications'}
        </button>
      </div>
    </div>
  )
}
