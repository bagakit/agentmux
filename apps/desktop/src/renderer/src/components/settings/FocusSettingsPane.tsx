import { FOCUS_RECENT_ACTIVITY_HOURS, resolveFocusRecentActivityHours, type FocusRecentActivityHours, resolveFocusLinkDestination, type FocusLinkDestination } from '../../../../shared/focus-preferences'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import '../../styles/settings-focus.css'

export function FocusSettingsPane({ recentActivityHours, linkDestination, onSave }: {
  recentActivityHours: FocusRecentActivityHours | undefined
  linkDestination?: FocusLinkDestination
  onSave(value: FocusRecentActivityHours, expected: FocusRecentActivityHours, link?: FocusLinkDestination, expectedLink?: FocusLinkDestination): Promise<void>
}) {
  const saved = resolveFocusRecentActivityHours(recentActivityHours)
  const draft = useSettingDraft(saved)
  const linkDraft = useSettingDraft(resolveFocusLinkDestination(linkDestination))
  const saveState = useSettingsSave()
  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    const submittedLink = linkDraft.beginSave()
    const saved = await saveState.run(() => linkDraft.dirty
      ? onSave(submitted.value, submitted.expected, submittedLink.value, submittedLink.expected)
      : onSave(submitted.value, submitted.expected))
    submitted.finish(saved)
    submittedLink.finish(saved)
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
    <section className="settings-group">
      <header><span>Open links in Focus</span></header>
      <fieldset className="focus-settings-window"><legend>Default destination</legend>
        {(['region', 'tab'] as const).map(destination => <label key={destination} data-selected={linkDraft.value === destination}>
          <input type="radio" name="focus-link-destination" checked={linkDraft.value === destination} onChange={() => linkDraft.setValue(destination)} />
          <span>{destination === 'region' ? 'Beside the Agent' : 'New Tab in Space'}</span>
        </label>)}
      </fieldset>
      <p className="focus-settings-description">Click a link to open it. Alt-click chooses its position. A Region keeps the Agent and opens the resource beside it; a Tab takes you to Space.</p>
    </section>
    <p className="focus-settings-footnote">Time ruler and time zone are adjusted directly in the Focus timeline.</p>
    <SettingsSaveBar save={saveState} dirty={draft.dirty || linkDraft.dirty} onSave={() => void save()} />
  </div>
}
