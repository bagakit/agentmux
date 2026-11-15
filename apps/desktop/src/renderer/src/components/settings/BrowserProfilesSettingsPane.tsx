import { BrowserProfilePendingCreations } from './BrowserProfilePendingCreations'
import { submitProfileCreation } from '../../lib/browser-profile-creations'
import { BrowserProfileCookieFiles } from './BrowserProfileCookieFiles'
import { BrowserProfileBookmarks } from './BrowserProfileBookmarks'
import { BrowserProfileExtensions } from './BrowserProfileExtensions'
import { Switch, TextInput, Textarea } from '@agentmux/client-ui/input'
import * as RovingFocus from '@radix-ui/react-roving-focus'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { describeError, presentError } from '@agentmux/client-ui/error-presentation'
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { SettingsNavigation } from '../SettingsNavigation'
import type { BrowserProfileSite, BrowserProfileSummary, BrowserProfileFolder } from '../../../../shared/contracts'
import { BROWSER_PROFILE_COOKIE_SKIP_REASONS, type BrowserProfileCookieSkipCounts, type BrowserProfileCookieSkipReason } from '../../../../shared/browser-profile-import-skip'
import { api } from '../../lib/api'
import { browserProfiles, useBrowserProfiles } from '../../lib/browser-profiles'
import { browserProfileTextDrafts, createBrowserProfileTextDrafts, profileTextValue, type ProfileTextField } from '../../lib/browser-profile-text-drafts'
import { browserProfileEnvironmentDescription } from '../../lib/browser-profile-presentation'
import { useAppStore } from '../../store'
import { awaitDesktopPresentation, desktopElementVisible, readDesktopOverlays } from '../../lib/desktop-presentation'
import { tabGroupForTab, workbenchSurfaces } from '../../lib/workbench-tabs'
import { PROFILE_HUES, ProfileMark, profileTone, assignProfileHues } from '../ProfileMark'
import { BrowserProfileLibrary } from './BrowserProfileLibrary'
import { BrowserProfileTrash } from './BrowserProfileTrash'
import { ProfileExitCheck, ProfileNetworkRoute, ProfileProxySignIn } from './BrowserProfileNetwork'
import { ProfileNetworkDiagnostics } from './ProfileNetworkDiagnostics'
import { ProfileEnvironmentEditor } from './ProfileEnvironmentEditor'
import { BrowserProfileOrganization } from './BrowserProfileOrganization'
import { SettingsConceptSummary } from './SettingsConceptSummary'
import * as Menu from '../HoverDropdownMenu'
import { DocumentOverlayPortal } from '../WindowOverlayHost'
import { useBrowserProfileTextEditor } from './useBrowserProfileTextEditor'
import './settings-browser-profiles.css'

const ThemeActionCreateIcon = semanticIconComponent('action.create')
const ThemeActionDownloadIcon = semanticIconComponent('action.download')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeStatusSavedIcon = semanticIconComponent('status.saved')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')
const ThemeNavigationNextIcon = semanticIconComponent('navigation.next')

/** The palette lives with the mark, so a chosen and an automatic Profile color can never drift apart. */
export { PROFILE_HUES }
const HUE_NAMES: Readonly<Record<number, string>> = { 178: 'Teal', 246: 'Indigo', 270: 'Violet', 294: 'Plum', 318: 'Orchid', 338: 'Rose' }

/** What each skip reason means to the person who imported, said once here rather than per caller. */
const SKIP_LABELS: Readonly<Record<BrowserProfileCookieSkipReason, string>> = {
  expired: 'Already expired',
  'invalid-cookie': 'Not a valid cookie',
  'app-bound-encryption': 'Locked to the other browser by its app-bound encryption',
  undecryptable: 'Could not be decrypted',
  'non-transplantable': 'Bound to that browser and cannot move',
  'partition-unreadable': 'Its site partition could not be read',
  'partition-family-unreadable': 'Its partitioned site group could not be read'
}

/** Reasons in the importer's order; zero counts are never stored. */
function skipLines(counts: BrowserProfileCookieSkipCounts | undefined): { reason: BrowserProfileCookieSkipReason; label: string; count: number }[] {
  if (!counts) return []
  return BROWSER_PROFILE_COOKIE_SKIP_REASONS.flatMap(reason => counts[reason] ? [{ reason, label: SKIP_LABELS[reason], count: counts[reason] }] : [])
}

type Failure = { code: string | null; message: string }
/** Runs one edit. A caller that decides by the refusal's code asks for the failure itself. */
type Run = {
  (key: string, action: () => Promise<unknown>): Promise<boolean>
  (key: string, action: () => Promise<unknown>, report: true): Promise<true | Failure>
}

type Use = { browserId: string; tabId: string; title: string; url: string; state: 'open' | 'saved' }

/** Close Settings, then select the exact Browser Region; selection is refused while Settings covers the workbench. */
async function showBrowser(use: Use, onClose: () => void): Promise<void> {
  onClose()
  await awaitDesktopPresentation(() => !readDesktopOverlays().settings)
  const state = useAppStore.getState()
  const tab = state.tabs[use.tabId], groupId = tab ? tabGroupForTab(state.layouts[tab.workspaceId], use.tabId) : null
  if (tab && groupId && state.selectMainRegion({ displayWorkspaceId: tab.workspaceId, groupId, tabId: use.tabId, regionId: use.browserId })) return
  state.reportError(new Error(`“${use.title || use.url}” could not be shown. Its Tab is kept; open it from its Space.`), { kind: 'indeterminate' })
}

/** Close Settings and open a new Browser in this Profile beside the current work. */
async function openInProfile(profileId: string, onClose: () => void): Promise<void> {
  onClose()
  await awaitDesktopPresentation(() => !readDesktopOverlays().settings)
  const state = useAppStore.getState()
  const workspaceId = state.activeWorkspaceId
  const layout = workspaceId ? state.layouts[workspaceId] : undefined
  if (!workspaceId || !layout) { state.reportError(new Error('Open a Space first, then open a Browser in this Profile.'), { kind: 'indeterminate' }); return }
  try { await state.createBrowser(layout.activeGroupId, undefined, 'about:blank', undefined, workspaceId, workspaceId, 'normal', undefined, profileId) }
  catch (error) { state.reportError(error, { kind: 'indeterminate' }) }
}

/** The one line that tells this Profile apart: default, what it is for, or where it came from. */
function detailLine(profile: BrowserProfileSummary): string {
  const about = profile.notes?.split('\n')[0] ?? (profile.source ? `From ${profile.source.browserLabel} · ${profile.source.profileLabel}` : '')
  return profile.isDefault ? (about ? `Default · ${about}` : 'Default') : about
}

/** Settings › Browser Profiles: every Profile in one list, one Profile edited in place beside it. */
export function BrowserProfilesSettingsPane({ active, onClose = () => {} }: { active: boolean; onClose?: () => void }) {
  const list = useBrowserProfiles(active)
  const tabs = useAppStore(state => state.tabs)
  // The Profile switch only narrows the global one, so the editor says when the global switch already keeps Agents out.
  const automation = useAppStore(state => state.config?.browser?.agentAutomation === true)
  const exitCheckUrl = useAppStore(state => state.config?.browser?.exitCheckUrl ?? '')
  // Derive each Browser's use once; adding unrelated Profiles does not rescan pages.
  const usage = useMemo(() => {
    const byProfile = new Map<string, Use[]>(), openCounts = new Map<string, number>()
    for (const tab of Object.values(tabs)) for (const surface of workbenchSurfaces(tab)) {
      if (surface.kind !== 'browser') continue
      const profileId = surface.profileId
      if (!profileId) continue
      const use: Use = { browserId: surface.browserId, tabId: tab.id, title: surface.title, url: surface.url,
        state: surface.nativeOwnerDeferred || surface.nativeOwnerReleased ? 'saved' : 'open' }
      const uses = byProfile.get(profileId)
      if (uses) uses.push(use)
      else byProfile.set(profileId, [use])
      if (use.state === 'open') openCounts.set(profileId, (openCounts.get(profileId) ?? 0) + 1)
    }
    return { byProfile, openCounts }
  }, [tabs])
  const profiles = list.profiles ?? []
  const folders = list.folders ?? []
  const hueAssignment = useMemo(() => assignProfileHues(profiles), [list.profiles])
  const [showTrash, setShowTrash] = useState(false)
  const retainedEditor = useRef<BrowserProfileSummary | null>(null)
  const [restoredTarget, setRestoredTarget] = useState<{ id: string; label: string } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'library' | 'editor'>('editor')
  const [returnFocus, setReturnFocus] = useState<{ id: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The refusal's machine code decides recovery; the shown sentence never does.
  const [errorCode, setErrorCode] = useState<string | null>(null)
  // A confirmed recycle/restore notice outlives the editor without discarding its draft.
  const [notice, setNotice] = useState<string | null>(null)
  const [copyTarget, setCopyTarget] = useState<{ id: string; label: string } | null>(null)
  const [textDrafts] = useState(() => __AGENTMUX_WEB_PREVIEW__ ? createBrowserProfileTextDrafts() : browserProfileTextDrafts)
  const draftStorageError = useSyncExternalStore(textDrafts.subscribe, textDrafts.storageError)
  const selected = profiles.find(profile => profile.id === selectedId) ?? (retainedEditor.current?.id === selectedId ? retainedEditor.current : null) ?? profiles.find(profile => profile.isDefault) ?? profiles[0] ?? null
  if (selected) retainedEditor.current = selected
  const selectedIsActive = selected !== null && profiles.some(profile => profile.id === selected.id)
  useEffect(() => {
    if (active) { void browserProfiles.refresh(); void textDrafts.load() }
  }, [active, textDrafts])

  const run = (async (key: string, action: () => Promise<unknown>, report = false) => {
    if (busy) return report ? { code: null, message: '' } : false
    setBusy(key); setError(null); setErrorCode(null)
    try { await action(); return true }
    catch (cause) {
      const failure = { code: describeError(cause).code ?? null, message: presentError(cause) }
      setError(failure.message); setErrorCode(failure.code)
      if (failure.code === 'BROWSER_PROFILE_WRITE_UNCONFIRMED') { setNotice(failure.message); setCopyTarget(null) }
      return report ? failure : false
    }
    finally { setBusy(null) }
  }) as Run
  const [renameRequest, setRenameRequest] = useState<string | null>(null)
  const create = async () => {
    const taken = new Set(profiles.map(profile => profile.label))
    let n = 1
    while (taken.has(`Profile ${n}`)) n += 1
    const label = `Profile ${n}`
    let created: string | null = null
    if (await run('create', async () => { const result = await submitProfileCreation({ operation: 'browser.profile.create', label }); created = result.creation.receipt!.createdId; if (result.creation.current.state !== 'present') throw new Error('The original created Profile is now ' + result.creation.current.state + '. Its creation receipt is retained.') })) {
      setSelectedId(created!); setView('editor'); setRenameRequest(created!)
    }
  }


  const copy = async (profile: BrowserProfileSummary, revision: string) => {
    const taken = new Set(profiles.map(value => value.label))
    let n = 1, label: string
    do { const suffix = n === 1 ? ' copy' : ` copy ${n}`; label = profile.label.slice(0, 128 - suffix.length).trimEnd() + suffix; n += 1 } while (taken.has(label))
    let copied: string | null = null
    if (await run('copy', async () => { const result = await submitProfileCreation({ operation: 'browser.profile.copy', profileId: profile.id, label, expectedRevision: revision }); copied = result.creation.receipt!.createdId; if (result.creation.current.state !== 'present') throw new Error('The original copied Profile is now ' + result.creation.current.state + '. Its creation receipt is retained.') })) {
      // Keep the source editor mounted: its unsaved route/sign-in inputs belong to the person.
      setCopyTarget({ id: copied!, label })
      setNotice(`Copied saved settings to “${label}”. Sign-ins, site data and approvals stay with the original Profile.`)
    }
  }

  return (
    <div className="settings-resource-workbench settings-browser-profiles" data-resource-view={view} data-settings-field="browser-profiles">
      <SettingsConceptSummary icon="object.settings-browser-use" title="Sign-ins, pages and environment"
        description="Choose a Profile to continue its pages. Network and device settings stay with that same environment." />
      <BrowserProfilePendingCreations />
      <div className="settings-pane-toolbar">
        <strong>Profiles <span>{list.profiles ? profiles.length : '…'}</span></strong>
        <button className="small-button" type="button" aria-label="New Profile" title="New Profile" disabled={busy !== null || !list.profiles} onClick={() => void create()}>
          {busy === 'create' ? <ThemeStatusLoadingIcon animation="spin" size={13} /> : <ThemeActionCreateIcon size={13} />} New
        </button>
        <button className="small-button" type="button" aria-pressed={showTrash} onClick={() => setShowTrash(value => !value)}>Recycled Profiles</button>
        <ImportMenu disabled={busy !== null || !list.profiles} onImported={id => { setSelectedId(id); setView('editor') }} />
      </div>
      {notice ? <p className="browser-profiles-settings__service" role="status">{notice}{' '}
        {copyTarget ? <button type="button" onClick={() => { setSelectedId(copyTarget.id); setView('editor'); setRenameRequest(copyTarget.id); setCopyTarget(null); setNotice(null) }}>Edit copy</button> : null}{' '}
        {restoredTarget ? <button type="button" onClick={() => { setSelectedId(restoredTarget.id); setShowTrash(false); setView('editor'); setRestoredTarget(null); setNotice(null) }}>Edit restored Profile</button> : null}{' '}
        <button type="button" aria-label="Dismiss" onClick={() => { setNotice(null); setCopyTarget(null); setRestoredTarget(null) }}>Dismiss</button></p> : null}
      {list.error ? <p className="browser-profiles-settings__service" role="status">
        Couldn’t refresh Profiles{list.profiles ? '; showing the last list' : ''}. {list.error}{' '}
        <button type="button" disabled={list.reading} onClick={() => void browserProfiles.refresh()}>{list.reading ? 'Retrying…' : 'Retry'}</button>
      </p> : null}
      {draftStorageError ? <p className="browser-profiles-settings__service" role="status">
        Profile name and notes draft storage is unconfirmed. {draftStorageError}{' '}
        <button type="button" onClick={() => void textDrafts.checkpoint()}>Retry draft storage</button>
      </p> : null}
      <BrowserProfileTrash active={active && showTrash} folders={folders} onBack={() => setShowTrash(false)} onRestored={(id, label) => { setRestoredTarget({ id, label }); setNotice(`Restored \"${label}\" with its original sign-ins and site data.`) }} />
      <div className="settings-resource-split" hidden={showTrash}>
        <BrowserProfileLibrary list={list} active={active && !showTrash} selectedId={selected?.id ?? null} focusRequest={returnFocus} assignment={hueAssignment} openCounts={usage.openCounts} detailLine={detailLine}
          onSelect={id => { setSelectedId(id); setView('editor'); setError(null); setErrorCode(null) }} />
        <div className="settings-resource-editor">
          {!selectedIsActive && selected ? <p className="browser-profiles-settings__service" role="status">This Profile is recycled. Its editor draft is kept. <button type="button" onClick={() => setShowTrash(true)}>Show recycled Profiles</button></p> : null}
          <div hidden={!selectedIsActive}>
          <button className="small-button settings-resource-back" type="button" onClick={() => { setView('library'); setReturnFocus({ id: selected?.id ?? null }) }}>
            <ThemeNavigationBackIcon size={13} />All Profiles
          </button>
          {selected && list.revision !== null ? <ProfileEditor active={active && !showTrash} assignment={hueAssignment} key={selected.id} profile={selected} textDrafts={textDrafts} revision={list.revision} folders={folders} proxies={list.proxies ?? []}
            uses={usage.byProfile.get(selected.id) ?? []} busy={busy} run={run} error={error} errorCode={errorCode} automation={automation} exitCheckUrl={exitCheckUrl}
            onShow={use => void showBrowser(use, onClose)} onOpen={() => void openInProfile(selected.id, onClose)}
            onCopy={() => void copy(selected, selected.revision)}
            editName={renameRequest === selected.id} onNameEdited={() => setRenameRequest(null)}
            onDeleted={() => { setSelectedId(selected.id); setShowTrash(true); setError(null); setErrorCode(null); setCopyTarget(null); setNotice(`Recycled \"${selected.label}\". Its original sign-ins, site data and saved settings are kept.`) }} />
            : <p className="settings-resource-empty" role="status">{list.reading ? 'Loading Profiles…' : 'No Profile selected.'}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

function ProfileEditor({ active, assignment, profile, textDrafts, revision, uses, busy, run, error, errorCode, automation, exitCheckUrl, editName, onNameEdited, onDeleted, onShow, onOpen, onCopy, folders, proxies }: {
  active: boolean
  profile: BrowserProfileSummary
  textDrafts: ReturnType<typeof createBrowserProfileTextDrafts>
  folders: BrowserProfileFolder[]
  proxies: import('@agentmux/core/control').BrowserProxyAsset[]
  assignment: ReadonlyMap<string, number>
  revision: number
  uses: Use[]
  busy: string | null
  run: Run
  error: string | null
  errorCode: string | null
  /** Settings › Browser › Agent browser automation. */
  automation: boolean
  /** Settings › Browser › Exit check address; empty means no check is offered. */
  exitCheckUrl: string
  editName: boolean
  onNameEdited(): void
  /** Confirmed active-to-archive transition; all original data remains retained. */
  onDeleted(): void
  onShow(use: Use): void
  onOpen(): void
  onCopy(): void
}) {
  const [hues, setHues] = useState(false)
  const [saved, setSaved] = useState(false)
  const name = useBrowserProfileTextEditor<HTMLInputElement>(profile, 'label', textDrafts, editName, () => setSaved(true))
  const notes = useBrowserProfileTextEditor<HTMLTextAreaElement>(profile, 'notes', textDrafts, false, () => setSaved(true))
  const nameFeedback = useId(), notesFeedback = useId()
  useEffect(() => { if (editName) onNameEdited() }, [editName, onNameEdited])
  const [confirm, setConfirm] = useState<'delete' | null>(null)
  const recycleRevision = useRef(profile.revision)
  const [baselineRefresh, setBaselineRefresh] = useState(0)
  const markButton = useRef<HTMLButtonElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const huesGroup = useRef<HTMLDivElement>(null)
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const accessFocus = useRef<HTMLInputElement | null>(null)
  useLayoutEffect(() => {
    if (active && busy !== null) return
    const control = accessFocus.current
    accessFocus.current = null
    if (!active || !control || !desktopElementVisible(control)) return
    const document = control.ownerDocument
    if (document.hasFocus() && document.activeElement === document.body) control.focus({ preventScroll: true })
  }, [active, busy])
  // Opening the color picker or the delete confirmation moves focus into it; closing returns it.
  useEffect(() => { if (hues) huesGroup.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus() }, [hues])
  useEffect(() => { if (confirm) cancelDelete.current?.focus() }, [confirm])
  const closeHues = () => { setHues(false); markButton.current?.focus() }
  const closeConfirm = () => { setConfirm(null); moreButton.current?.focus() }
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(false), 1200); return () => clearTimeout(timer) }, [saved])

  const commit = async (edit: Parameters<typeof api.browser.updateProfile>[1], expectedRevision = profile.revision): Promise<boolean> => {
    const ok = await run('edit', () => api.browser.updateProfile(profile.id, edit, expectedRevision))
    if (ok) setSaved(true)
    return ok
  }
  const blockedDelete = profile.isDefault ? 'The default Profile can’t be recycled' : uses.length ? `Used by ${uses.length} Browser${uses.length > 1 ? 's' : ''}` : null
  const open = uses.filter(use => use.state === 'open')

  return (
    <article className="browser-profile-editor" aria-label={profile.label}>
      <header className="browser-profile-editor__identity">
        <button ref={markButton} type="button" className="browser-profile-editor__mark" aria-label={`Color for ${profile.label}`} aria-expanded={hues}
          onClick={() => setHues(value => !value)}><ProfileMark assignment={assignment} profile={profile} size="large" /></button>
        <div className="browser-profile-editor__who">
          {name.editing ? <TextInput ref={name.control} aria-label="Profile name" value={name.value} maxLength={128}
            aria-describedby={name.draft ? nameFeedback : undefined}
            aria-invalid={name.draft && !name.value.trim() ? true : undefined}
            onChange={event => { setSaved(false); name.change(event.currentTarget.value) }} onKeyDown={name.onKeyDown} onBlur={name.onBlur}
            onFocus={name.onFocus} onCompositionStart={name.onCompositionStart} onCompositionEnd={name.onCompositionEnd} />
            : <h3><button ref={name.opener} type="button" className="browser-profile-editor__name" onClick={name.start} title="Rename">{profile.label}</button>
              {saved && !notes.editing ? <span className="browser-profile-editor__saved" role="status"><ThemeStatusSavedIcon size={12} /> Saved</span> : null}</h3>}
          <small>{profile.isDefault ? 'Default for new Browsers · ' : ''}{open.length ? `Open in ${open.length} Browser${open.length > 1 ? 's' : ''}` : 'Not open'}</small>
        </div>
        <button type="button" className="primary-button browser-profile-editor__open" onClick={onOpen}>Open Browser</button>
        <Menu.Root>
          <Menu.Trigger asChild><button ref={moreButton} type="button" className="icon-button" aria-label={`More for ${profile.label}`}><ThemeActionMoreIcon size={14} /></button></Menu.Trigger>
          <DocumentOverlayPortal component={Menu.Portal}>
            <Menu.Content className="tab-context-menu" align="end" collisionPadding={8}>
              <Menu.Item className="tab-context-menu__item" disabled={profile.isDefault} onSelect={() => void run('default', () => api.browser.setDefaultProfile(profile.id))}>
                {profile.isDefault ? 'Default for new Browsers' : 'Make default'}
              </Menu.Item>
              <Menu.Item className="tab-context-menu__item" onSelect={name.start}>Rename</Menu.Item>
              <Menu.Item className="tab-context-menu__item" disabled={busy !== null} onSelect={onCopy}>Copy settings</Menu.Item>
              <Menu.Separator className="tab-context-menu__separator" />
              <Menu.Item className="tab-context-menu__item browser-profile-menu__delete" disabled={blockedDelete !== null} onSelect={() => { recycleRevision.current = profile.revision; setConfirm('delete') }}>
                <span>Recycle Profile…</span>{blockedDelete ? <small>{blockedDelete}</small> : null}
              </Menu.Item>
            </Menu.Content>
          </DocumentOverlayPortal>
        </Menu.Root>
      </header>

      {/* Arrow keys move between colors and Enter picks one: each pick is a saved edit, so moving never saves. */}
      {hues ? <RovingFocus.Root asChild orientation="horizontal" loop>
        <div ref={huesGroup} className="browser-profile-editor__hues" role="radiogroup" aria-label={`Color for ${profile.label}`}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeHues() } }}>
          {PROFILE_HUES.map(hue => {
            const checked = profile.hue === hue
            return <RovingFocus.Item key={hue} asChild active={checked}>
              <button type="button" role="radio" aria-checked={checked} aria-label={HUE_NAMES[hue] ?? `Hue ${hue}`} title={HUE_NAMES[hue]}
                data-tone={profileTone(hue)} style={{ '--profile-hue': hue } as CSSProperties} onClick={() => { closeHues(); if (!checked) void commit({ hue }) }} />
            </RovingFocus.Item>
          })}
          <RovingFocus.Item asChild active={profile.hue === undefined}>
            <button type="button" className="browser-profile-editor__auto" aria-checked={profile.hue === undefined} role="radio"
              title="A color picked from the Profile itself" onClick={() => { closeHues(); if (profile.hue !== undefined) void commit({ hue: null }) }}>Automatic</button>
          </RovingFocus.Item>
        </div>
      </RovingFocus.Root> : null}

      {name.draft ? <ProfileTextFeedback id={nameFeedback} field="label" editor={name} /> : null}
      {notes.editing ? <Textarea ref={notes.control} className="browser-profile-editor__notes" aria-label="Notes" maxLength={2000} value={notes.value}
          aria-describedby={notes.draft ? notesFeedback : undefined}
          onChange={event => { setSaved(false); notes.change(event.currentTarget.value) }} onKeyDown={notes.onKeyDown} onBlur={notes.onBlur}
          onFocus={notes.onFocus} onCompositionStart={notes.onCompositionStart} onCompositionEnd={notes.onCompositionEnd} />
        : <button ref={notes.opener} type="button" className="browser-profile-editor__note" data-empty={profile.notes ? undefined : ''} onClick={notes.start}>
          {profile.notes || 'What is this environment for?'}
        </button>}
      {notes.draft ? <ProfileTextFeedback id={notesFeedback} field="notes" editor={notes} /> : null}

      {error ? <p className="browser-profile-editor__error" role="alert">{error}{errorCode === 'BROWSER_PROFILE_REVISION_CONFLICT' ? <> <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => void (async () => {
        await browserProfiles.refresh()
        const current = browserProfiles.get().profiles?.find(value => value.id === profile.id)
        if (current) setBaselineRefresh(value => value + 1)
      })()}>Reload</button></> : null}</p> : null}

      <BrowserProfileOrganization profile={profile} folders={folders} revision={revision} busy={busy !== null} run={run} onEdit={commit} />

      <section className="browser-profile-editor__section" aria-label="Agents">
        <h4>Agents</h4>
        <label className="browser-automation-toggle browser-profile-editor__agents">
          <Switch checked={profile.agentAccess !== false} disabled={busy !== null}
            onChange={event => {
              const control = event.currentTarget
              accessFocus.current = control.matches(':focus-visible') ? control : null
              void commit({ agentAccess: control.checked })
            }} />
          <span>
            <strong>Let agents use Browsers in this Profile</strong>
            <small>{!automation ? 'Agent browser automation is off in Settings › Browser, so no agent uses any Profile right now.'
              : profile.agentAccess === false ? 'Agents are refused here. You can still run your own steps.'
              : 'Agents may read and act on pages in this Profile’s Browsers, with its sign-ins.'}</small>
          </span>
        </label>
      </section>

      <section className="browser-profile-editor__section" aria-label="In use">
        <h4>In use</h4>
        {uses.length ? <ul className="browser-profile-editor__uses">
          {uses.map(use => <li key={use.browserId}><button type="button" className="browser-profile-editor__use" onClick={() => onShow(use)}
            title={use.state === 'open' ? 'Show this Browser' : 'Show this Browser; it loads when shown'}>
            <ThemeObjectBrowserIcon size={13} /><span>{use.title || use.url || 'New Browser'}</span>
            <small data-state={use.state}>{use.state === 'open' ? 'Running' : 'Not loaded yet'}</small>
            <ThemeNavigationNextIcon className="browser-profile-editor__go" size={12} aria-hidden="true" /></button></li>)}
        </ul> : <p className="browser-profile-editor__quiet">No Browser in this workface uses this Profile.</p>}
      </section>

      <ProfileSites profile={profile} />
      <BrowserProfileBookmarks profile={profile} active={active} />
      <BrowserProfileExtensions profile={profile} />
      <BrowserProfileCookieFiles profile={profile} active={active} />

      <details className="browser-profile-editor__advanced">
        <summary>Network and device settings<small>{browserProfileEnvironmentDescription(profile)}</small></summary>
        <p className="browser-profile-editor__quiet">Optional settings for this environment. Existing settings stay in effect when this section is closed.</p>
        <ProfileEnvironmentEditor profile={profile} />

        {/* The editor is already keyed by Profile, so each section starts fresh per Profile without a key of its own. */}
        <ProfileNetworkRoute profile={profile} proxy={proxies.find(proxy => proxy.id === profile.proxyBinding?.proxyId)} baselineRefresh={baselineRefresh} openBrowsers={open.length} run={run} />
        {profile.network?.mode === 'proxy' ? <ProfileProxySignIn profile={profile} /> : null}

        {/* A reading belongs to the route and check address that produced it, including late results. */}
        <ProfileExitCheck key={JSON.stringify([profile.network ?? null, exitCheckUrl])} profile={profile} address={exitCheckUrl} />
        <ProfileNetworkDiagnostics profile={profile} />

      </details>

      <section className="browser-profile-editor__section" aria-label="Observed activity">
        <h4>Observed activity</h4>
        <p className="browser-profile-editor__quiet">Last observed use: {profile.activity
          ? <time dateTime={Number.isFinite(new Date(profile.activity.lastUsedAt).getTime()) ? new Date(profile.activity.lastUsedAt).toISOString() : undefined}>{new Date(profile.activity.lastUsedAt).toLocaleString()}</time> : 'Unknown'}</p>
        <p className="browser-profile-editor__quiet">Observed Browser time: {profile.activity
          ? profile.activity.observedRunMs < 1000 ? 'Less than a second confirmed' : `${Math.floor(profile.activity.observedRunMs / 1000)} s confirmed` : 'Unknown'}</p>
        <p className="browser-profile-editor__quiet">Overlapping pages count once. Earlier or interrupted use is unknown.
          {profile.activity?.state === 'unknown' ? ' The last native observation was interrupted; its confirmed time is kept.' : ''}</p>
      </section>

      {profile.source ? <section className="browser-profile-editor__section" aria-label="Imported">
        <h4>Imported</h4>
        <p className="browser-profile-editor__quiet">{profile.source.browserLabel} · {profile.source.profileLabel}: {profile.source.importedCookies} cookies, {profile.source.skippedCookies} skipped</p>
        {skipLines(profile.source.skippedByReason).length ? <ul className="browser-profile-editor__skips" aria-label="Why cookies were skipped">
          {skipLines(profile.source.skippedByReason).map(line => <li key={line.reason}><span>{line.label}</span><small>{line.count}</small></li>)}
        </ul> : null}
      </section> : null}

      {confirm === 'delete' ? <div className="browser-profile-editor__confirm" role="alertdialog" aria-label={`Recycle ${profile.label}`}
        onKeyDown={event => { if (event.key === 'Escape' && busy !== 'delete') { event.preventDefault(); event.stopPropagation(); closeConfirm() } }}>
        <p>Recycle <strong>{profile.label}</strong>? Its original sign-ins, site data and saved settings stay here so you can restore it. This does not free disk space or create a separate backup. Unsaved editor inputs are kept, not saved into the recycled settings.</p>
        <div>
          <button ref={cancelDelete} type="button" className="small-button" onClick={closeConfirm}>Cancel</button>
          <button type="button" className="danger-button" disabled={busy !== null} onClick={() => void run('delete', () => api.browser.deleteProfile(profile.id,
            { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: profile.id }, recycleRevision.current), true).then(result => {
              if (result === true) { setConfirm(null); onDeleted() }
              else setConfirm(null)
            })}>
            {busy === 'delete' ? <ThemeStatusLoadingIcon animation="spin" size={12} /> : null}Recycle {profile.label}
          </button>
        </div>
      </div> : null}
    </article>
  )
}

function ProfileTextFeedback({ id, field, editor }: {
  id: string
  field: ProfileTextField
  editor: Pick<ReturnType<typeof useBrowserProfileTextEditor>, 'draft' | 'isSaving' | 'message' | 'checked' | 'retry' | 'reload' | 'discard' | 'hasEarlier' | 'showEarlier'>
}) {
  const draft = editor.draft
  if (!draft) return null
  const label = field === 'label' ? 'Name' : 'Notes'
  const pending = editor.isSaving
  const conflict = draft.state === 'conflict'
  const unconfirmed = !pending && (draft.state === 'saving' || draft.state === 'unconfirmed')
  const invalid = field === 'label' && !draft.value.trim()
  const checkedValue = editor.checked && profileTextValue(editor.checked, field)
  const canSave = !pending && !conflict && !invalid && (!unconfirmed || checkedValue !== undefined && checkedValue !== draft.value.trim())
  const message = pending ? `Saving ${label.toLowerCase()}…` : invalid ? 'Enter a Profile name.' : conflict ? editor.message ?? `${label} draft kept. Reload the current Profile before saving again.` :
    unconfirmed ? `${label} save unconfirmed. Your draft is kept.` : draft.state === 'failed' ? `${label} could not be saved. Your draft is kept.` : `${label} draft`
  return <p id={id} className="browser-profile-editor__error" role={conflict || unconfirmed || invalid || draft.state === 'failed' ? 'alert' : 'status'} data-profile-text-draft={field}>
    {message}{' '}{editor.message && !conflict ? `${editor.message} ` : null}
    {checkedValue !== undefined ? <>{checkedValue === draft.attempt?.value ? 'The current Profile shows the submitted value.' : 'The current Profile shows a different value.'}{' '}</> : null}
    <span className="browser-profile-text-draft__actions">
      {conflict || unconfirmed ? <button className="small-button" type="button" onMouseDown={event => event.preventDefault()} onClick={() => void editor.reload()}>{conflict ? 'Reload' : 'Check saved Profile'}</button> : null}
      {canSave ? <button className="small-button" type="button" onMouseDown={event => event.preventDefault()} onClick={editor.retry}>Save draft</button> : null}
      <button className="small-button" type="button" onMouseDown={event => event.preventDefault()} onClick={editor.discard}>Discard draft</button>
      {editor.hasEarlier && !pending ? <button className="small-button" type="button" onMouseDown={event => event.preventDefault()} onClick={editor.showEarlier}>Show earlier draft</button> : null}
    </span>
  </p>
}

/**
 * Sites holding sign-ins in this Profile, read only when asked: the list is private metadata and
 * reading it touches the Profile's session. Clearing one site is confirmed in place and names its result.
 */
function ProfileSites({ profile }: { profile: BrowserProfileSummary }) {
  const [sites, setSites] = useState<BrowserProfileSite[] | null>(null)
  const [state, setState] = useState<'idle' | 'reading' | 'clearing'>('idle')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [result, setResult] = useState<{ kind: 'cleared' | 'failed'; text: string } | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (confirm) cancel.current?.focus() }, [confirm])
  const read = async () => {
    setState('reading'); setResult(null)
    try { setSites(await api.browser.listProfileSites(profile.id)) }
    catch (cause) { setResult({ kind: 'failed', text: `Couldn’t read this Profile’s sites. ${presentError(cause)}` }) }
    finally { setState('idle') }
  }
  const clear = async (site: string) => {
    setState('clearing')
    try {
      await api.browser.clearProfileSite(profile.id, site, { kind: 'user-confirmed', operation: 'clear-site-data', scope: 'profile-site', profileId: profile.id, site })
      setSites(current => current?.filter(entry => entry.site !== site) ?? null)
      setResult({ kind: 'cleared', text: `Signed out of ${site} in ${profile.label}. Reload its open pages to see it.` })
    } catch (cause) { setResult({ kind: 'failed', text: `${site} was not cleared. ${presentError(cause)}` }) }
    finally { setState('idle'); setConfirm(null) }
  }
  return (
    <section className="browser-profile-editor__section" aria-label="Sites with sign-ins">
      <h4>Sites with sign-ins</h4>
      {sites === null ? <p className="browser-profile-editor__quiet">
        <button type="button" className="browser-profile-editor__link" disabled={state !== 'idle'} onClick={() => void read()}>
          {state === 'reading' ? 'Reading…' : 'Show sites'}</button></p>
        : sites.length === 0 ? <p className="browser-profile-editor__quiet">No site has sign-ins in this Profile.</p>
        : <ul className="browser-profile-editor__sites">
          {sites.map(entry => <li key={entry.site}>
            {confirm === entry.site ? <div className="browser-profile-editor__site-confirm" role="alertdialog" aria-label={`Clear ${entry.site}`}
              onKeyDown={event => { if (event.key === 'Escape' && state !== 'clearing') { event.preventDefault(); event.stopPropagation(); setConfirm(null) } }}>
              <span>Sign out of <strong>{entry.site}</strong> and remove its site data in this Profile?</span>
              <button ref={cancel} type="button" className="small-button" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="danger-button" disabled={state === 'clearing'} onClick={() => void clear(entry.site)}>
                {state === 'clearing' ? <ThemeStatusLoadingIcon animation="spin" size={12} /> : null}Clear {entry.site}</button>
            </div> : <>
              <span>{entry.site}</span><small>{entry.cookies} cookie{entry.cookies === 1 ? '' : 's'}</small>
              <button type="button" className="small-button" disabled={state !== 'idle'} aria-label={`Clear ${entry.site}`} onClick={() => setConfirm(entry.site)}>Clear…</button>
            </>}
          </li>)}
        </ul>}
      {result ? <p className={result.kind === 'cleared' ? 'browser-profile-editor__quiet' : 'browser-profile-editor__error'} role={result.kind === 'cleared' ? 'status' : 'alert'}>{result.text}</p> : null}
    </section>
  )
}

function ImportMenu({ disabled, onImported }: { disabled: boolean; onImported(id: string): void }) {
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.browser.detectProfileImportSources>> | null>(null)
  const [state, setState] = useState<'idle' | 'detecting' | 'importing'>('idle')
  const [error, setError] = useState<string | null>(null)
  const detect = async (open: boolean) => {
    if (!open || state !== 'idle') return
    setState('detecting'); setError(null)
    try { setSources(await api.browser.detectProfileImportSources()) }
    catch (cause) { setError(presentError(cause)) }
    finally { setState('idle') }
  }
  const importFrom = async (token: string, label: string) => {
    setState('importing'); setError(null)
    try { onImported((await api.browser.importProfile(token, label)).id) }
    catch (cause) { setError(presentError(cause)) }
    finally { setState('idle') }
  }
  return (
    <>
      <Menu.Root onOpenChange={open => void detect(open)}>
        <Menu.Trigger asChild><button type="button" className="small-button" disabled={disabled || state === 'importing'}>
          {state === 'importing' ? <ThemeStatusLoadingIcon animation="spin" size={13} /> : <ThemeActionDownloadIcon size={13} />} Import…
        </button></Menu.Trigger>
        <DocumentOverlayPortal component={Menu.Portal}>
          <Menu.Content className="tab-context-menu" align="end" collisionPadding={8}>
            <Menu.Label className="tab-context-menu__hint">Import sign-ins from a browser on this Mac</Menu.Label>
            {state === 'detecting' ? <Menu.Item className="tab-context-menu__item" disabled>Looking for browsers…</Menu.Item>
              : sources?.length ? sources.map(source => <Menu.Item key={source.token} className="tab-context-menu__item"
                onSelect={() => void importFrom(source.token, `${source.browserLabel} ${source.profileLabel}`)}>{source.browserLabel} · {source.profileLabel}</Menu.Item>)
              : <Menu.Item className="tab-context-menu__item" disabled>No supported browser found</Menu.Item>}
          </Menu.Content>
        </DocumentOverlayPortal>
      </Menu.Root>
      {error ? <p className="browser-profiles-settings__service" role="alert">{error}</p> : null}
    </>
  )
}
