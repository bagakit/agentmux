import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { browserProfiles, useBrowserProfiles } from '../../lib/browser-profiles'
import { clearsSemanticHues } from '../../lib/conversation-avatar-color'
import { useAppStore } from '../../store'
import { workbenchSurfaces, type BrowserWorkbenchSurface } from '../../lib/workbench-tabs'
import { ProfileMark, profileHue } from '../ProfileMark'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'
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

/** Identity hues a person can pick: teal through rose, well clear of the hues that mean
 *  success, attention, failure or a person. Lime and yellow-green read as success, so none here. */
export const PROFILE_HUES = [180, 248, 266, 284, 302, 320, 338].filter(clearsSemanticHues)

type Use = { browserId: string; title: string; url: string; state: 'open' | 'saved' }

function usesOf(profileId: string, surfaces: readonly BrowserWorkbenchSurface[]): Use[] {
  return surfaces.filter(surface => surface.profileId === profileId).map(surface => ({
    browserId: surface.browserId, title: surface.title, url: surface.url,
    state: surface.nativeOwnerDeferred || surface.nativeOwnerReleased ? 'saved' : 'open'
  }))
}

/** The one line that tells this Profile apart: default, what it is for, or where it came from. */
function detailLine(profile: BrowserProfileSummary): string {
  const about = profile.notes?.split('\n')[0] ?? (profile.source ? `From ${profile.source.browserLabel} · ${profile.source.profileLabel}` : '')
  return profile.isDefault ? (about ? `Default · ${about}` : 'Default') : about
}

/** Settings › Browser Profiles: every Profile in one list, one Profile edited in place beside it. */
export function BrowserProfilesSettingsPane({ active }: { active: boolean }) {
  const list = useBrowserProfiles()
  const tabs = useAppStore(state => state.tabs)
  const surfaces = useMemo(() => Object.values(tabs).flatMap(tab => workbenchSurfaces(tab))
    .flatMap(surface => surface.kind === 'browser' ? [surface] : []), [tabs])
  const profiles = list.profiles ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'library' | 'editor'>('editor')
  const [returnFocus, setReturnFocus] = useState<{ id: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selected = profiles.find(profile => profile.id === selectedId) ?? profiles.find(profile => profile.isDefault) ?? profiles[0] ?? null
  useEffect(() => { if (active) void browserProfiles.refresh() }, [active])

  // Find by anything a person remembers about a Profile: its name, its note, or where it came from.
  const needle = query.trim().toLowerCase()
  const visible = profiles.filter(profile => !needle || [profile.label, profile.notes ?? '', profile.source?.browserLabel ?? '', profile.source?.profileLabel ?? '']
    .some(text => text.toLowerCase().includes(needle)))
  const run = async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(key); setError(null)
    try { await action(); return true }
    catch (cause) { setError(presentError(cause)); return false }
    finally { setBusy(null) }
  }
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
        <button className="small-button" type="button" disabled={busy !== null || !list.profiles} onClick={() => void create()}>
          {busy === 'create' ? <ThemeStatusLoadingIcon animation="spin" size={13} /> : <ThemeActionCreateIcon size={13} />} New Profile
        </button>
        <ImportMenu disabled={busy !== null || !list.profiles} onImported={id => { setSelectedId(id); setView('editor') }} />
      </div>
      {list.error ? <p className="browser-profiles-settings__service" role="status">
        Couldn’t refresh Profiles{list.profiles ? '; showing the last list' : ''}. {list.error}{' '}
        <button type="button" disabled={list.reading} onClick={() => void browserProfiles.refresh()}>{list.reading ? 'Retrying…' : 'Retry'}</button>
      </p> : null}
      <div className="settings-resource-split">
        <SettingsResourceLibrary label="Profiles" selectedId={selected?.id ?? null} query={query} onQuery={setQuery} focusRequest={returnFocus} followFocus
          onSelect={id => { setSelectedId(id); setView('editor'); setError(null) }}
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
            uses={usesOf(selected.id, surfaces)} busy={busy} run={run} error={error}
            editName={renameRequest === selected.id} onNameEdited={() => setRenameRequest(null)}
            onDeleted={() => { setSelectedId(null); setView('library') }} />
            : <p className="settings-resource-empty" role="status">{list.reading ? 'Loading Profiles…' : 'No Profile selected.'}</p>}
        </div>
      </div>
    </div>
  )
}

function ProfileEditor({ profile, revision, uses, busy, run, error, editName, onNameEdited, onDeleted }: {
  profile: BrowserProfileSummary
  revision: number
  uses: Use[]
  busy: string | null
  run(key: string, action: () => Promise<unknown>): Promise<boolean>
  error: string | null
  editName: boolean
  onNameEdited(): void
  onDeleted(): void
}) {
  const [naming, setNaming] = useState(editName)
  const [name, setName] = useState(profile.label)
  const [notes, setNotes] = useState(profile.notes ?? '')
  const [noting, setNoting] = useState(false)
  const [hues, setHues] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirm, setConfirm] = useState<'delete' | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
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
        <button type="button" className="browser-profile-editor__mark" aria-label={`Color for ${profile.label}`} aria-expanded={hues}
          onClick={() => setHues(value => !value)}><ProfileMark profile={profile} size="large" /></button>
        <div className="browser-profile-editor__who">
          {naming ? <TextInput ref={nameInput} aria-label="Profile name" value={name} maxLength={128}
            onChange={event => setName(event.target.value)} onKeyDown={nameKeys} onBlur={() => void finishName(true)} />
            : <h3><button type="button" className="browser-profile-editor__name" onClick={() => setNaming(true)} title="Rename">{profile.label}</button>
              {saved ? <span className="browser-profile-editor__saved" role="status"><ThemeStatusSavedIcon size={12} /> Saved</span> : null}</h3>}
          <small>{profile.isDefault ? 'Default for new Browsers · ' : ''}{open.length ? `Open in ${open.length} Browser${open.length > 1 ? 's' : ''}` : 'Not open'}</small>
        </div>
        <Menu.Root>
          <Menu.Trigger asChild><button type="button" className="icon-button" aria-label={`More for ${profile.label}`}><ThemeActionMoreIcon size={14} /></button></Menu.Trigger>
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

      {hues ? <div className="browser-profile-editor__hues" role="radiogroup" aria-label="Profile color">
        {PROFILE_HUES.map(hue => <button key={hue} type="button" role="radio" aria-checked={profileHue(profile) === hue} aria-label={`Hue ${hue}`}
          style={{ '--profile-hue': hue } as CSSProperties} onClick={() => { setHues(false); if (profileHue(profile) !== hue) void commit({ hue }) }} />)}
        <button type="button" className="browser-profile-editor__auto" aria-checked={profile.hue === undefined} role="radio"
          onClick={() => { setHues(false); if (profile.hue !== undefined) void commit({ hue: null }) }}>Automatic</button>
      </div> : null}

      {noting ? <textarea className="browser-profile-editor__notes" aria-label="Notes" autoFocus rows={2} maxLength={2000} value={notes}
          onChange={event => setNotes(event.target.value)} onBlur={() => void finishNotes()}
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setNotes(profile.notes ?? ''); setNoting(false) } }} />
        : <button type="button" className="browser-profile-editor__note" data-empty={profile.notes ? undefined : ''} onClick={() => setNoting(true)}>
          {profile.notes || 'Add a note'}
        </button>}

      {error ? <p className="browser-profile-editor__error" role="alert">{error}{/changed since/i.test(error) ? <> <button type="button" onClick={() => void browserProfiles.refresh()}>Reload</button></> : null}</p> : null}

      <section className="browser-profile-editor__section" aria-label="In use">
        <h4>In use</h4>
        {uses.length ? <ul className="browser-profile-editor__uses">
          {uses.map(use => <li key={use.browserId}><ThemeObjectBrowserIcon size={13} /><span>{use.title || use.url || 'New Browser'}</span>
            <small data-state={use.state}>{use.state === 'open' ? 'Open' : 'Not loaded yet'}</small></li>)}
        </ul> : <p className="browser-profile-editor__quiet">No Browser uses this Profile.</p>}
      </section>

      {profile.source ? <section className="browser-profile-editor__section" aria-label="Imported">
        <h4>Imported</h4>
        <p className="browser-profile-editor__quiet">{profile.source.browserLabel} · {profile.source.profileLabel}: {profile.source.importedCookies} cookies, {profile.source.skippedCookies} skipped</p>
      </section> : null}

      {confirm === 'delete' ? <div className="browser-profile-editor__confirm" role="alertdialog" aria-label={`Delete ${profile.label}`}>
        <p>Delete <strong>{profile.label}</strong>? Its sign-ins, cookies, site data and address history are removed for good.</p>
        <div>
          <button type="button" className="small-button" onClick={() => setConfirm(null)}>Cancel</button>
          <button type="button" className="danger-button" disabled={busy !== null} onClick={() => void run('delete', () => api.browser.deleteProfile(profile.id,
            { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: profile.id })).then(ok => { if (ok) onDeleted(); else setConfirm(null) })}>
            {busy === 'delete' ? <ThemeStatusLoadingIcon animation="spin" size={12} /> : null}Delete {profile.label}
          </button>
        </div>
      </div> : null}
    </article>
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
