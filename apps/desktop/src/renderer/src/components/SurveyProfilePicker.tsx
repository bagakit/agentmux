import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SurveyProfileView } from '../lib/survey-profile-view'
import type { BrowserProfilesState } from '../lib/browser-profiles'
import { useBrowserDirectory } from '../lib/use-browser-directory'
import { browserProfileEnvironmentDescription, browserProfileUseCounts, browserProfileUseDescription } from '../lib/browser-profile-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ProfileMark, assignProfileHues } from './ProfileMark'
import { SelectionField, type SelectionOption } from './SelectionField'
import { SettingsNavigation } from './SettingsNavigation'
import '../styles/survey-profile-picker.css'
const RefreshIcon = semanticIconComponent('action.refresh')
const BrowserIcon = semanticIconComponent('object.browser')
const SettingsIcon = semanticIconComponent('object.settings')

export function SurveyProfilePicker({ value, profiles, collapsed, active = true, unknown = false, onExpand, onChange, onRefresh }: {
  value: SurveyProfileView
  profiles: BrowserProfilesState
  collapsed: boolean
  active?: boolean
  unknown?: boolean
  onExpand(): void
  onChange(view: SurveyProfileView): void
  onRefresh(): void
}) {
  const settings = useContext(SettingsNavigation)
  const picker = useRef<HTMLDivElement>(null), focusAfterExpand = useRef(false)
  const [open, setOpen] = useState(false)
  const directory = useBrowserDirectory(open && active && !collapsed)
  const usage = useMemo(() => browserProfileUseCounts(directory.rows, directory.coverage), [directory.rows, directory.coverage])
  const assignment = useMemo(() => assignProfileHues(profiles.profiles ?? []), [profiles.profiles])
  useEffect(() => { if (!active || collapsed) setOpen(false) }, [active, collapsed])
  useLayoutEffect(() => { if (!collapsed && focusAfterExpand.current) { focusAfterExpand.current = false; picker.current?.querySelector<HTMLButtonElement>('.selection-field')?.focus() } }, [collapsed])
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
  const detail = unknown ? 'The saved environment view is unconfirmed. Choose an environment for a new page.' : value.kind === 'profile' ? `${label}\nProfile ID: ${value.profileId}` : `${label}\nUses the persistent default sign-in environment.`
  const option = (profile: NonNullable<BrowserProfilesState['profiles']>[number], optionValue: string): SelectionOption => ({
    value: optionValue,
    label: profile.label + ((nameCounts.get(profile.label) ?? 0) > 1 ? ` · ${profile.id.slice(0, 6)}` : ''),
    icon: <ProfileMark profile={profile} assignment={assignment} />,
    description: [profile.isDefault ? 'Default environment' : profile.notes?.split('\n')[0],
      browserProfileUseDescription(usage.counts.get(profile.id), usage.complete)].filter(Boolean).join(' · ') + '\n' + browserProfileEnvironmentDescription(profile)
  })
  const options: SelectionOption[] = [
    ...(unknown ? [{ value: 'unconfirmed', label: 'Choose an environment…', description: 'Saved environment view unconfirmed', disabled: true }] : []),
    currentDefault ? option(currentDefault, defaultValue) : { value: defaultValue, label: 'Default environment', icon: <BrowserIcon size={16} />, description: 'Uses the persistent default sign-in environment' },
    ...(profiles.profiles ?? []).filter(profile => !profile.isDefault).map(profile => option(profile, 'profile:' + profile.id)),
    ...(missing && value.kind === 'profile' ? [{ value: selected, label: 'Unavailable environment', description: `Profile ${value.profileId}\nIts saved pages are kept.` }] : [])
  ]
  if (collapsed) return <button type="button" className="survey-profile-collapsed" aria-label="Choose Survey environment" title={detail}
    onClick={() => { focusAfterExpand.current = true; onExpand() }}>{shown ? <ProfileMark profile={shown} assignment={assignment} /> : <BrowserIcon size={16} />}</button>
  return <div ref={picker} className="survey-profile-picker" title={detail}>
    <SelectionField label="Survey environment" value={selected} options={options} searchable open={open && active && !collapsed} onOpenChange={setOpen}
      className="survey-profile-picker__trigger" menuClassName="survey-profile-picker__menu"
      onValueChange={next => {
        picker.current?.querySelector<HTMLButtonElement>('.survey-profile-picker__trigger')?.focus({ preventScroll: true })
        onChange(next === 'default' ? { kind: 'default' } : { kind: 'profile', profileId: next.slice('profile:'.length) })
      }}
      footer={settings || directory.notice ? <>
        {directory.notice ? <>
          <p className="survey-profile-picker__observation" role="status">{directory.notice}</p>
          <button type="button" className="selection-field__option survey-profile-picker__manage" onClick={() => void directory.refresh()}>
            <RefreshIcon size={14} /><span>Refresh browser use</span>
          </button>
        </> : null}
        {settings ? <button type="button" className="selection-field__option survey-profile-picker__manage" onClick={() => { setOpen(false); settings.open('browser-profiles') }}>
          <SettingsIcon size={14} /><span>Manage environments…</span>
        </button> : null}
      </> : undefined} />
    {profiles.error ? <p role="status">Environment list unconfirmed. Default browsing is available.
      <button type="button" className="survey-icon-button" aria-label="Refresh Survey environments" onClick={onRefresh}><RefreshIcon size={13} /></button>
    </p> : missing ? <p role="status">This environment has no confirmed directory entry. Its saved pages are kept.</p> : null}
  </div>
}
