import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useContext, useState } from 'react'
import type { AgentMuxBrowserControl } from '@agentmux/core'
import { api } from '../lib/api'
import { useBrowserProfiles } from '../lib/browser-profiles'
import * as Menu from './HoverDropdownMenu'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { ProfileMark } from './ProfileMark'
import { SettingsNavigation } from './SettingsNavigation'

const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')

/**
 * The Profile this Browser uses, in its toolbar. Shown only when there is a choice to tell apart.
 * Switching is the person's action: it needs human control and reloads the page into the other
 * Profile, so an Agent-held Browser lists Profiles but cannot switch. The new mark shows at once,
 * the old page stays until the new one commits, and a failure returns to the original Profile.
 */
export function BrowserProfileChip({ browserId, profileId, control }: {
  browserId: string
  profileId: string | null
  control: AgentMuxBrowserControl | undefined
}) {
  const list = useBrowserProfiles()
  const settings = useContext(SettingsNavigation)
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const profiles = list.profiles ?? []
  if (profileId === null || profiles.length < 2) return null
  const shown = profiles.find(profile => profile.id === (pending ?? profileId))
  if (!shown) return null
  const agentHolds = control?.owner === 'agent'
  const switchTo = async (target: string) => {
    if (target === profileId || pending) return
    setPending(target); setFailure(null)
    try { await api.browser.switchProfile(browserId, target) }
    catch (cause) { setFailure(presentError(cause)) }
    finally { setPending(null) }
  }
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button type="button" className="browser-profile-chip" data-pending={pending ? '' : undefined}
            aria-label={`Profile: ${shown.label}`} title={pending ? `Switching to ${shown.label}…` : `Profile: ${shown.label}`}>
            <ProfileMark profile={shown} />
            <span>{shown.label}</span>
            {pending ? <ThemeStatusLoadingIcon animation="spin" size={11} /> : <ThemeNavigationDisclosureIcon size={11} />}
          </button>
        </Menu.Trigger>
        <DocumentOverlayPortal component={Menu.Portal}>
          <Menu.Content className="tab-context-menu browser-profile-switcher" align="start" collisionPadding={8}>
            {profiles.map(profile => (
              <Menu.Item key={profile.id} className="tab-context-menu__item" disabled={agentHolds && profile.id !== profileId}
                title={agentHolds && profile.id !== profileId ? 'Take control to switch Profile' : undefined}
                onSelect={() => void switchTo(profile.id)}>
                <ProfileMark profile={profile} />
                <span>{profile.label}</span>
                {profile.id === profileId ? <ThemeStatusSelectedIcon size={13} aria-label="Current" /> : profile.isDefault ? <small>Default</small> : null}
              </Menu.Item>
            ))}
            {agentHolds ? <Menu.Label className="tab-context-menu__hint">An Agent controls this page. Take control to switch Profile.</Menu.Label>
              : <Menu.Label className="tab-context-menu__hint">Switching reloads this page in the other Profile.</Menu.Label>}
            {settings ? <>
              <Menu.Separator className="tab-context-menu__separator" />
              <Menu.Item className="tab-context-menu__item tab-context-menu__item--quiet" onSelect={() => settings.open('browser-profiles')}>
                <span>Manage Browser Profiles…</span>
              </Menu.Item>
            </> : null}
          </Menu.Content>
        </DocumentOverlayPortal>
      </Menu.Root>
      {failure ? <span className="browser-profile-chip__failure" role="status" title={failure}>
        Couldn’t switch <button type="button" onClick={() => setFailure(null)}>Dismiss</button>
      </span> : null}
    </>
  )
}
