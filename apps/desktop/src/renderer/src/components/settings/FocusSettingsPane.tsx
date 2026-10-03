import { FOCUS_RECENT_ACTIVITY_HOURS, resolveFocusRecentActivityHours, type FocusRecentActivityHours } from '../../../../shared/focus-preferences'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import '../../styles/settings-focus.css'

export function FocusSettingsPane({ recentActivityHours, onSave }: {
  recentActivityHours: FocusRecentActivityHours | undefined
  onSave(value: FocusRecentActivityHours, expected: FocusRecentActivityHours): Promise<void>
}) {
  const saved = resolveFocusRecentActivityHours(recentActivityHours)
  const draft = useSettingDraft(saved)
  const saveState = useSettingsSave()
  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }
  return <div className="settings-pane-stack">
    <section className="settings-group">
      <header><span>Recent activity</span><small>Saved: {saved} hours</small></header>
      <p className="focus-settings-description">Keep projects with recent task activity ahead of older work in Focus.</p>
      <fieldset className="focus-settings-window"><legend>Recent activity window</legend>
        {FOCUS_RECENT_ACTIVITY_HOURS.map(hours => <label key={hours} data-selected={draft.value === hours}>
          <input type="radio" name="focus-recent-activity" value={hours} checked={draft.value === hours} onChange={() => draft.setValue(hours)} />
          <span>{hours === 168 ? '1 week' : `${hours} hours`}</span>
        </label>)}
      </fieldset>
      <p className="focus-settings-description">Attention and Working stay first. Older projects and activity with unknown time remain available.</p>
    </section>
    <p className="focus-settings-footnote">Time ruler and time zone are adjusted directly in the Focus timeline.</p>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} onSave={() => void save()} />
  </div>
}
