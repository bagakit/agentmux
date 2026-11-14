import { useContext, useLayoutEffect, useRef } from 'react'
import type { SurveyProfileView } from '../lib/survey-profile-view'
import type { BrowserProfilesState } from '../lib/browser-profiles'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ProfileMark } from './ProfileMark'
import { SettingsNavigation } from './SettingsNavigation'
const RefreshIcon = semanticIconComponent('action.refresh')
const BrowserIcon = semanticIconComponent('object.browser')

export function SurveyProfilePicker({ value, profiles, collapsed, unknown = false, onExpand, onChange, onRefresh }: {
  value: SurveyProfileView
  profiles: BrowserProfilesState
  collapsed: boolean
  unknown?: boolean
  onExpand(): void
  onChange(view: SurveyProfileView): void
  onRefresh(): void
}) {
  const settings = useContext(SettingsNavigation)
  const select = useRef<HTMLSelectElement>(null), focusAfterExpand = useRef(false)
  useLayoutEffect(() => { if (!collapsed && focusAfterExpand.current) { focusAfterExpand.current = false; select.current?.focus() } }, [collapsed])
  const currentDefault = profiles.profiles?.find(profile => profile.isDefault)
  const shown = value.kind === 'profile' ? profiles.profiles?.find(profile => profile.id === value.profileId) : currentDefault
  const selected = unknown ? 'unconfirmed' : value.kind === 'default' ? 'default' : 'profile:' + value.profileId
  // One physical environment gets one row. An already explicit default ID
  // remains explicit; rendering this alias does not rewrite its saved intent.
  const defaultValue = !unknown && value.kind === 'profile' && currentDefault?.id === value.profileId ? selected : 'default'
  const missing = value.kind === 'profile' && !shown
  const nameCounts = new Map<string, number>()
  for (const profile of profiles.profiles ?? []) nameCounts.set(profile.label, (nameCounts.get(profile.label) ?? 0) + 1)
  const label = shown?.label ?? (value.kind === 'default' ? 'Default environment' : 'Unavailable environment')
  const detail = unknown ? 'The saved environment view is unconfirmed. Choose an environment for a new page.' : value.kind === 'profile' ? `${label}\nProfile ID: ${value.profileId}` : `${label}\nUses Main’s current persistent default environment.`
  if (collapsed) return <button type="button" className="survey-profile-collapsed" aria-label="Choose Survey environment" title={detail}
    onClick={() => { focusAfterExpand.current = true; onExpand() }}>{shown ? <ProfileMark profile={shown} /> : <BrowserIcon size={16} />}</button>
  return <div className="survey-profile-picker">
    <label title={detail}>{shown ? <ProfileMark profile={shown} /> : <BrowserIcon size={14} />}
      <select ref={select} aria-label="Survey environment" title={detail} value={selected} onChange={event => onChange(event.target.value === 'default'
        ? { kind: 'default' } : { kind: 'profile', profileId: event.target.value.slice('profile:'.length) })}>
        {unknown ? <option value="unconfirmed" disabled>Choose an environment…</option> : null}
        <option value={defaultValue} data-profile-id={currentDefault?.id}>{currentDefault ? `${currentDefault.label} · Default` : 'Default environment'}</option>
        {profiles.profiles?.filter(profile => !profile.isDefault).map(profile => <option key={profile.id} value={'profile:' + profile.id} data-profile-id={profile.id}>
          {profile.label}{(nameCounts.get(profile.label) ?? 0) > 1 ? ` · ${profile.id.slice(0, 6)}` : ''}
        </option>)}
        {missing && value.kind === 'profile' ? <option value={selected}>Unavailable environment · {value.profileId.slice(0, 6)}</option> : null}
      </select>
    </label>
    <div className="survey-profile-options">
      {settings ? <button type="button" onClick={() => settings.open('browser-profiles')}>Manage environments…</button> : null}
      <details><summary>Details</summary><span>{detail}</span></details>
    </div>
    {profiles.error ? <p role="status">Environment list unconfirmed. Default browsing is available.
      <button type="button" className="survey-icon-button" aria-label="Refresh Survey environments" onClick={onRefresh}><RefreshIcon size={13} /></button>
    </p> : missing ? <p role="status">This environment has no confirmed directory entry. Its saved pages are kept.</p> : null}
  </div>
}
