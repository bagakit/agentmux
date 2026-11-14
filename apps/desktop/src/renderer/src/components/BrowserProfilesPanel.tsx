import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useContext } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { useBrowserProfiles } from '../lib/browser-profiles'
import { ProfileMark } from './ProfileMark'
import { SettingsNavigation } from './SettingsNavigation'

const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')

/**
 * Browser tools keep a short reading of the Profiles and one way to manage them. Creating,
 * renaming, importing and deleting live in Settings › Browser Profiles; switching a Browser's
 * Profile lives on its toolbar chip. One editor for each fact, so nothing here can disagree.
 */
export function BrowserProfilesPanel() {
  const list = useBrowserProfiles()
  const settings = useContext(SettingsNavigation)
  const profiles = list.profiles ?? []
  return (
    <section className="browser-profiles" aria-label="Browser Profiles">
      <header><strong>Profiles</strong><span>{list.profiles ? profiles.length : '…'}</span></header>
      {profiles.length ? <ul className="browser-profiles__marks" aria-label="Browser Profiles">
        {profiles.map(profile => <li key={profile.id} title={profile.isDefault ? `${profile.label} · Default` : profile.label}><ProfileMark profile={profile} /></li>)}
      </ul> : null}
      {list.error ? <p className="browser-profiles__note" role="status">{list.error}</p> : null}
      {settings ? <Button type="button" className="browser-profiles__manage" onClick={() => settings.open('browser-profiles')}>
        Manage Browser Profiles <ThemeNavigationDisclosureIcon size={11} />
      </Button> : null}
    </section>
  )
}
