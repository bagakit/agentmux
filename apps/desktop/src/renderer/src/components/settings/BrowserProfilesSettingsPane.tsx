import { TextInput } from '@agentmux/client-ui/input'
import * as RovingFocus from '@radix-ui/react-roving-focus'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { describeError, presentError } from '@agentmux/client-ui/error-presentation'
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { SettingsNavigation } from '../SettingsNavigation'
import type { BrowserProfileSite, BrowserProfileSummary } from '../../../../shared/contracts'
import { BROWSER_PROFILE_COOKIE_SKIP_REASONS, type BrowserProfileCookieSkipCounts, type BrowserProfileCookieSkipReason } from '../../../../shared/browser-profile-import-skip'
import { api } from '../../lib/api'
import { browserProfiles, useBrowserProfiles } from '../../lib/browser-profiles'
import { useAppStore } from '../../store'
import { awaitDesktopPresentation, readDesktopOverlays } from '../../lib/desktop-presentation'
import { tabGroupForTab, workbenchSurfaces, type BrowserWorkbenchSurface } from '../../lib/workbench-tabs'
import { PROFILE_HUES, ProfileMark, profileHue } from '../ProfileMark'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
import { ProfileExitCheck, ProfileNetworkRoute, ProfileProxySignIn } from './BrowserProfileNetwork'
import * as Menu from '../HoverDropdownMenu'
import { DocumentOverlayPortal } from '../WindowOverlayHost'
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
const HUE_NAMES: Readonly<Record<number, string>> = { 180: 'Teal', 248: 'Indigo', 266: 'Violet', 284: 'Purple', 302: 'Orchid', 320: 'Magenta', 338: 'Rose' }

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

function usesOf(profileId: string, surfaces: readonly (BrowserWorkbenchSurface & { tabId: string })[]): Use[] {
  return surfaces.filter(surface => surface.profileId === profileId).map(surface => ({
    browserId: surface.browserId, tabId: surface.tabId, title: surface.title, url: surface.url,
    state: surface.nativeOwnerDeferred || surface.nativeOwnerReleased ? 'saved' : 'open'
  }))
}

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
  const list = useBrowserProfiles()
  const tabs = useAppStore(state => state.tabs)
  // The Profile switch only narrows the global one, so the editor says when the global switch already keeps Agents out.
  const automation = useAppStore(state => state.config?.browser?.agentAutomation === true)
  const exitCheckUrl = useAppStore(state => state.config?.browser?.exitCheckUrl ?? '')
  const surfaces = useMemo(() => Object.values(tabs).flatMap(tab => workbenchSurfaces(tab)
    .flatMap(surface => surface.kind === 'browser' ? [{ ...surface, tabId: tab.id }] : [])), [tabs])
  const profiles = list.profiles ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'library' | 'editor'>('editor')
  const [returnFocus, setReturnFocus] = useState<{ id: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The refusal's machine code decides recovery; the shown sentence never does.
  const [errorCode, setErrorCode] = useState<string | null>(null)
  // A delete that committed while its site data still clears: the Profile is gone, so the notice outlives its editor.
  const [notice, setNotice] = useState<string | null>(null)
  const selected = profiles.find(profile => profile.id === selectedId) ?? profiles.find(profile => profile.isDefault) ?? profiles[0] ?? null
  useEffect(() => { if (active) void browserProfiles.refresh() }, [active])

  // Find by anything a person remembers about a Profile: its name, its note, or where it came from.
  const needle = query.trim().toLowerCase()
  const visible = profiles.filter(profile => !needle || [profile.label, profile.notes ?? '', profile.source?.browserLabel ?? '', profile.source?.profileLabel ?? '']
    .some(text => text.toLowerCase().includes(needle)))
  const run = (async (key: string, action: () => Promise<unknown>, report = false) => {
    if (busy) return report ? { code: null, message: '' } : false
    setBusy(key); setError(null); setErrorCode(null)
    try { await action(); return true }
    catch (cause) {
      const failure = { code: describeError(cause).code ?? null, message: presentError(cause) }
      setError(failure.message); setErrorCode(failure.code)
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
    let created: BrowserProfileSummary | null = null
    if (await run('create', async () => { created = await api.browser.createProfile(label) })) {
      setSelectedId(created!.id); setView('editor'); setRenameRequest(created!.id)
    }
  }

  return (
    <div className="settings-resource-workbench settings-browser-profiles" data-resource-view={view} data-settings-field="browser-profiles">
      <div className="settings-pane-toolbar">
        <strong>Profiles <span>{list.profiles ? profiles.length : '…'}</span></strong>
        <button className="small-button" type="button" aria-label="New Profile" title="New Profile" disabled={busy !== null || !list.profiles} onClick={() => void create()}>
          {busy === 'create' ? <ThemeStatusLoadingIcon animation="spin" size={13} /> : <ThemeActionCreateIcon size={13} />} New
        </button>
        <ImportMenu disabled={busy !== null || !list.profiles} onImported={id => { setSelectedId(id); setView('editor') }} />
      </div>
      {notice ? <p className="browser-profiles-settings__service" role="status">{notice}{' '}
        <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>Dismiss</button></p> : null}
      {list.error ? <p className="browser-profiles-settings__service" role="status">
        Couldn’t refresh Profiles{list.profiles ? '; showing the last list' : ''}. {list.error}{' '}
        <button type="button" disabled={list.reading} onClick={() => void browserProfiles.refresh()}>{list.reading ? 'Retrying…' : 'Retry'}</button>
      </p> : null}
      <div className="settings-resource-split">
        <SettingsResourceLibrary label="Profiles" selectedId={selected?.id ?? null} query={query} onQuery={setQuery} focusRequest={returnFocus} followFocus
          onSelect={id => { setSelectedId(id); setView('editor'); setError(null); setErrorCode(null) }}
          items={visible.map(profile => {
            const open = usesOf(profile.id, surfaces).filter(use => use.state === 'open').length
            return { id: profile.id, name: profile.label, detail: detailLine(profile),
              mark: <ProfileMark profile={profile} />, status: open ? <span>{open} open</span> : undefined }
          })} />
        <div className="settings-resource-editor">
          <button className="small-button settings-resource-back" type="button" onClick={() => { setView('library'); setReturnFocus({ id: selected?.id ?? null }) }}>
            <ThemeNavigationBackIcon size={13} />All Profiles
          </button>
          {selected && list.revision !== null ? <ProfileEditor key={selected.id} profile={selected} revision={list.revision}
            uses={usesOf(selected.id, surfaces)} busy={busy} run={run} error={error} errorCode={errorCode} automation={automation} exitCheckUrl={exitCheckUrl}
            onShow={use => void showBrowser(use, onClose)} onOpen={() => void openInProfile(selected.id, onClose)}
            editName={renameRequest === selected.id} onNameEdited={() => setRenameRequest(null)}
            onDeleted={pending => { setSelectedId(null); setView('library'); setError(null); setErrorCode(null); setNotice(pending) }} />
            : <p className="settings-resource-empty" role="status">{list.reading ? 'Loading Profiles…' : 'No Profile selected.'}</p>}
        </div>
      </div>
    </div>
  )
}

function ProfileEditor({ profile, revision, uses, busy, run, error, errorCode, automation, exitCheckUrl, editName, onNameEdited, onDeleted, onShow, onOpen }: {
  profile: BrowserProfileSummary
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
  /** `pending` names site data that is still being cleared after the Profile was deleted. */
  onDeleted(pending: string | null): void
  onShow(use: Use): void
  onOpen(): void
}) {
  const [naming, setNaming] = useState(editName)
  const [name, setName] = useState(profile.label)
  const [notes, setNotes] = useState(profile.notes ?? '')
  const [noting, setNoting] = useState(false)
  const [hues, setHues] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirm, setConfirm] = useState<'delete' | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const markButton = useRef<HTMLButtonElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const huesGroup = useRef<HTMLDivElement>(null)
  const cancelDelete = useRef<HTMLButtonElement>(null)
  // Opening the color picker or the delete confirmation moves focus into it; closing returns it.
  useEffect(() => { if (hues) huesGroup.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus() }, [hues])
  useEffect(() => { if (confirm) cancelDelete.current?.focus() }, [confirm])
  const closeHues = () => { setHues(false); markButton.current?.focus() }
  const closeConfirm = () => { setConfirm(null); moreButton.current?.focus() }
  useEffect(() => { if (naming) { nameInput.current?.focus(); nameInput.current?.select() } }, [naming])
  useEffect(() => { if (!naming) setName(profile.label) }, [profile.label])
  useEffect(() => { if (!noting) setNotes(profile.notes ?? '') }, [profile.notes])
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(false), 1200); return () => clearTimeout(timer) }, [saved])

  const commit = async (edit: Parameters<typeof api.browser.updateProfile>[1]): Promise<boolean> => {
    const ok = await run('edit', () => api.browser.updateProfile(profile.id, edit, revision))
    if (ok) setSaved(true)
    return ok
  }
  // A refused edit reopens the field with the person's own text; nothing they typed is dropped.
  const finishName = async (keep: boolean) => {
    onNameEdited()
    const next = name.trim()
    if (!keep || !next || next === profile.label) { setNaming(false); setName(profile.label); return }
    setNaming(false)
    if (!await commit({ label: next })) { setName(next); setNaming(true) }
  }
  const nameKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); void finishName(true) }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void finishName(false) }
  }
  const finishNotes = async () => {
    const draft = notes
    setNoting(false)
    if (draft.trim() !== (profile.notes ?? '') && !await commit({ notes: draft.trim() })) { setNotes(draft); setNoting(true) }
  }
  const blockedDelete = profile.isDefault ? 'The default Profile can’t be deleted' : uses.length ? `Used by ${uses.length} Browser${uses.length > 1 ? 's' : ''}` : null
  const open = uses.filter(use => use.state === 'open')

  return (
    <article className="browser-profile-editor" aria-label={profile.label}>
      <header className="browser-profile-editor__identity">
        <button ref={markButton} type="button" className="browser-profile-editor__mark" aria-label={`Color for ${profile.label}`} aria-expanded={hues}
          onClick={() => setHues(value => !value)}><ProfileMark profile={profile} size="large" /></button>
        <div className="browser-profile-editor__who">
          {naming ? <TextInput ref={nameInput} aria-label="Profile name" value={name} maxLength={128}
            onChange={event => setName(event.target.value)} onKeyDown={nameKeys} onBlur={() => void finishName(true)} />
            : <h3><button type="button" className="browser-profile-editor__name" onClick={() => setNaming(true)} title="Rename">{profile.label}</button>
              {saved ? <span className="browser-profile-editor__saved" role="status"><ThemeStatusSavedIcon size={12} /> Saved</span> : null}</h3>}
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
              <Menu.Item className="tab-context-menu__item" onSelect={() => setNaming(true)}>Rename</Menu.Item>
              <Menu.Separator className="tab-context-menu__separator" />
              <Menu.Item className="tab-context-menu__item browser-profile-menu__delete" disabled={blockedDelete !== null} onSelect={() => setConfirm('delete')}>
                <span>Delete Profile…</span>{blockedDelete ? <small>{blockedDelete}</small> : null}
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
                style={{ '--profile-hue': hue } as CSSProperties} onClick={() => { closeHues(); if (!checked) void commit({ hue }) }} />
            </RovingFocus.Item>
          })}
          <RovingFocus.Item asChild active={profile.hue === undefined}>
            <button type="button" className="browser-profile-editor__auto" aria-checked={profile.hue === undefined} role="radio"
              title="A color picked from the Profile itself" onClick={() => { closeHues(); if (profile.hue !== undefined) void commit({ hue: null }) }}>Automatic</button>
          </RovingFocus.Item>
        </div>
      </RovingFocus.Root> : null}

      {noting ? <textarea className="browser-profile-editor__notes" aria-label="Notes" autoFocus rows={2} maxLength={2000} value={notes}
          onChange={event => setNotes(event.target.value)} onBlur={() => void finishNotes()}
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setNotes(profile.notes ?? ''); setNoting(false) } }} />
        : <button type="button" className="browser-profile-editor__note" data-empty={profile.notes ? undefined : ''} onClick={() => setNoting(true)}>
          {profile.notes || 'Add a note'}
        </button>}

      {error ? <p className="browser-profile-editor__error" role="alert">{error}{errorCode === 'BROWSER_PROFILE_REVISION_CONFLICT' ? <> <button type="button" onClick={() => void browserProfiles.refresh()}>Reload</button></> : null}</p> : null}

      <section className="browser-profile-editor__section" aria-label="Agents">
        <h4>Agents</h4>
        <label className="browser-automation-toggle browser-profile-editor__agents">
          <input type="checkbox" role="switch" checked={profile.agentAccess !== false} disabled={busy !== null}
            onChange={event => void commit({ agentAccess: event.target.checked })} />
          <span>
            <strong>Let agents use Browsers in this Profile</strong>
            <small>{!automation ? 'Agent browser automation is off in Settings › Browser, so no agent uses any Profile right now.'
              : profile.agentAccess === false ? 'Agents are refused here. You can still run your own steps.'
              : 'Agents may read and act on pages in this Profile’s Browsers, with its sign-ins.'}</small>
          </span>
        </label>
      </section>

      {/* The editor is already keyed by Profile, so each section starts fresh per Profile without a key of its own. */}
      <ProfileNetworkRoute profile={profile} revision={revision} openBrowsers={open.length} run={run} />
      {profile.network?.mode === 'proxy' ? <ProfileProxySignIn profile={profile} /> : null}

      <ProfileExitCheck profile={profile} address={exitCheckUrl} />

      <section className="browser-profile-editor__section" aria-label="In use">
        <h4>In use</h4>
        {uses.length ? <ul className="browser-profile-editor__uses">
          {uses.map(use => <li key={use.browserId}><button type="button" className="browser-profile-editor__use" onClick={() => onShow(use)}
            title={use.state === 'open' ? 'Show this Browser' : 'Show this Browser; it loads when shown'}>
            <ThemeObjectBrowserIcon size={13} /><span>{use.title || use.url || 'New Browser'}</span>
            <small data-state={use.state}>{use.state === 'open' ? 'Open' : 'Not loaded yet'}</small>
            <ThemeNavigationNextIcon className="browser-profile-editor__go" size={12} aria-hidden="true" /></button></li>)}
        </ul> : <p className="browser-profile-editor__quiet">No Browser uses this Profile.</p>}
      </section>

      <ProfileSites profile={profile} />

      {profile.source ? <section className="browser-profile-editor__section" aria-label="Imported">
        <h4>Imported</h4>
        <p className="browser-profile-editor__quiet">{profile.source.browserLabel} · {profile.source.profileLabel}: {profile.source.importedCookies} cookies, {profile.source.skippedCookies} skipped</p>
        {skipLines(profile.source.skippedByReason).length ? <ul className="browser-profile-editor__skips" aria-label="Why cookies were skipped">
          {skipLines(profile.source.skippedByReason).map(line => <li key={line.reason}><span>{line.label}</span><small>{line.count}</small></li>)}
        </ul> : null}
      </section> : null}

      {confirm === 'delete' ? <div className="browser-profile-editor__confirm" role="alertdialog" aria-label={`Delete ${profile.label}`}
        onKeyDown={event => { if (event.key === 'Escape' && busy !== 'delete') { event.preventDefault(); event.stopPropagation(); closeConfirm() } }}>
        <p>Delete <strong>{profile.label}</strong>? Its sign-ins, cookies, site data and address history are removed for good.</p>
        <div>
          <button ref={cancelDelete} type="button" className="small-button" onClick={closeConfirm}>Cancel</button>
          <button type="button" className="danger-button" disabled={busy !== null} onClick={() => void run('delete', () => api.browser.deleteProfile(profile.id,
            { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: profile.id }), true).then(result => {
              if (result === true) onDeleted(null)
              else if (result.code === 'BROWSER_PROFILE_DATA_CLEAR_PENDING') onDeleted(result.message)
              else setConfirm(null)
            })}>
            {busy === 'delete' ? <ThemeStatusLoadingIcon animation="spin" size={12} /> : null}Delete {profile.label}
          </button>
        </div>
      </div> : null}
    </article>
  )
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
