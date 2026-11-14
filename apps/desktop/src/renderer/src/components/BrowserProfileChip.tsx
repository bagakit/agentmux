import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useContext, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import type { SurveyProfileBindingReceipt } from '../lib/survey-profile-binding'
import type { AgentMuxBrowserControl } from '@agentmux/core'
import { useBrowserProfiles } from '../lib/browser-profiles'
import * as Menu from './HoverDropdownMenu'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { ProfileMark } from './ProfileMark'
import { SettingsNavigation } from './SettingsNavigation'
import { ServiceWindowNotice } from './ServiceWindowNotice'

const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')

/**
 * The Profile this Browser uses, in its toolbar. Shown only when there is a choice to tell apart.
 * Switching is the person's action: it needs human control and reloads the page into the other
 * Profile, so an Agent-held Browser lists Profiles but cannot switch. The new mark shows at once,
 * the old page stays until the new one commits, and a failure returns to the original Profile.
 */
export function BrowserProfileChip({ browserId, regionId, profileId, control, noticeHost }: {
  browserId: string
  regionId: string
  profileId: string | null
  control: AgentMuxBrowserControl | undefined
  noticeHost: HTMLElement | null
}) {
  const list = useBrowserProfiles()
  const settings = useContext(SettingsNavigation)
  const operation = useRef(0)
  const [registration, setRegistration] = useState<SurveyProfileBindingReceipt | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ target: string; message: string } | null>(null)
  const profiles = list.profiles ?? []
  if (profileId === null) return null
  // Unknown is said, not hidden: the page still uses a Profile even when the list cannot be read.
  if (!list.profiles) return list.error ? <span className="browser-profile-chip browser-profile-chip--unknown" role="status"
    title={`Profile unknown: ${list.error}`} aria-label="Profile unknown">Profile unknown</span> : null
  if (profiles.length < 2) return null
  const shown = profiles.find(profile => profile.id === (pending ?? profileId))
  const labelCounts = new Map<string, number>()
  for (const profile of profiles) labelCounts.set(profile.label, (labelCounts.get(profile.label) ?? 0) + 1)
  const label = (profile: (typeof profiles)[number]) => profile.label + ((labelCounts.get(profile.label) ?? 0) > 1 ? ` · ${profile.id.slice(0, 6)}` : '')
  if (!shown) return <span className="browser-profile-chip browser-profile-chip--unknown" role="status" aria-label="Profile unknown"
    title="This Browser's Profile is not in the current list.">Profile unknown</span>
  const agentHolds = control?.owner === 'agent'
  const switchTo = async (target: string) => {
    if (target === profileId || pending) return
    const token = ++operation.current
    setPending(target); setFailure(null); setRegistration(null)
    try {
      const receipt = await useAppStore.getState().switchBrowserProfileForSurvey({ regionId, browserId }, target)
      if (operation.current === token && receipt.admission.issues.length) setRegistration(receipt)
    } catch (cause) { if (operation.current === token) setFailure({ target, message: presentError(cause) }) }
    finally { if (operation.current === token) setPending(null) }
  }
  const superseded = registration?.admission.issues.some(issue => issue.code === 'SURVEY_PAGE_MEMBERSHIP_SUPERSEDED')
  const registrationNotice = registration ? <div data-survey-profile-registration={browserId}>
    <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
      step: 'Survey registration unconfirmed',
      mode: registration.switchOutcome === 'unconfirmed' ? 'Switch reply unconfirmed; current environment observed' : 'Environment changed',
      restore: registration.admission.issues.map(issue => `${issue.message} ${issue.recovery}`).join('\n')
    } }} summary={{
      step: superseded ? 'Later Survey choice kept' : 'Survey save unconfirmed',
      mode: registration.switchOutcome === 'unconfirmed' ? 'Switch reply unconfirmed; current environment observed' : 'Environment changed',
      restore: superseded ? 'The original page stays available. Its withdrawn reference is not added again.' : 'The page is available. Retry only its Survey reference.'
    }} actions={!superseded ? <button type="button" className="small-button" disabled={repairing} onClick={() => {
      const original = registration
      setRepairing(true)
      void useAppStore.getState().repairSurveyProfileAdmission(original).then(receipt => {
        setRegistration(current => current !== original ? current : receipt.admission.issues.length ? receipt : null)
      }).finally(() => setRepairing(false))
    }}>{repairing ? 'Saving Survey reference…' : 'Retry Survey registration'}</button> : null} />
  </div> : null
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button type="button" className="browser-profile-chip" data-pending={pending ? '' : undefined}
            aria-label={`Profile: ${label(shown)}`} title={pending ? `Switching to ${shown.label}…` : `Profile: ${shown.label}\n${shown.id}`}>
            <ProfileMark profile={shown} />
            <span>{label(shown)}</span>
            {pending ? <ThemeStatusLoadingIcon animation="spin" size={11} /> : <ThemeNavigationDisclosureIcon size={11} />}
          </button>
        </Menu.Trigger>
        <DocumentOverlayPortal component={Menu.Portal}>
          <Menu.Content className="tab-context-menu browser-profile-switcher" align="start" collisionPadding={8}>
            {profiles.map(profile => (
              <Menu.Item key={profile.id} data-profile-id={profile.id} className="tab-context-menu__item" disabled={agentHolds && profile.id !== profileId}
                title={agentHolds && profile.id !== profileId ? 'Take control to switch Profile' : undefined}
                onSelect={() => void switchTo(profile.id)}>
                <ProfileMark profile={profile} />
                <span title={profile.id}>{label(profile)}</span>
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
      {noticeHost ? createPortal(registrationNotice, noticeHost) : null}
      {failure ? <span className="browser-profile-chip__failure" role="status" title={failure.message}>
        Couldn’t switch · <button type="button" onClick={() => void switchTo(failure.target)}>Retry</button>
        <button type="button" aria-label="Dismiss" onClick={() => setFailure(null)}>×</button>
      </span> : null}
    </>
  )
}
