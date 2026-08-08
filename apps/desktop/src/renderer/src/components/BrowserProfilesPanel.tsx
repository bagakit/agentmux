import {
  Download,
  Globe2,
  LoaderCircle,
  Plus,
  Trash2,
  UserRound
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  BrowserProfileImportSourceSummary,
  BrowserProfileSummary
} from '../../../shared/contracts'
import type { BrowserWorkbenchSurface } from '../lib/workbench-tabs'
import { api } from '../lib/api'
import { presentError } from '../lib/error-presentation'

export type BrowserProfileSurface = Pick<
  BrowserWorkbenchSurface,
  'browserId' | 'profileId' | 'title' | 'url'
>

export function browserProfileIsInUse(
  profileId: string,
  browsers: readonly BrowserProfileSurface[]
): boolean {
  return browsers.some((browser) => browser.profileId === profileId)
}

function importedProfileDescription(profile: BrowserProfileSummary): string {
  if (!profile.source) return 'Empty isolated session'
  return `${profile.source.browserLabel} · ${profile.source.profileLabel} · ${profile.source.importedCookies} imported, ${profile.source.skippedCookies} skipped`
}

export function BrowserProfileCatalog({
  profiles,
  browsers,
  busy,
  confirmDeleteId,
  onConfirmDelete,
  onCancelDelete,
  onDelete
}: {
  profiles: readonly BrowserProfileSummary[]
  browsers: readonly BrowserProfileSurface[]
  busy: string | null
  confirmDeleteId: string | null
  onConfirmDelete(profileId: string): void
  onCancelDelete(): void
  onDelete(profileId: string): void
}) {
  return (
    <div className="browser-profiles__catalog">
      {profiles.map((profile) => {
        const inUse = browserProfileIsInUse(profile.id, browsers)
        const confirming = confirmDeleteId === profile.id
        return (
          <article key={profile.id}>
            <Globe2 size={13} />
            <span>
              <strong>{profile.label}{profile.isDefault ? <em>Default</em> : null}</strong>
              <small>{importedProfileDescription(profile)}</small>
            </span>
            {profile.isDefault || inUse ? (
              <button
                type="button"
                disabled
                aria-label={`Delete ${profile.label}`}
                title={profile.isDefault ? 'The default Profile cannot be deleted' : 'Close or switch its open Browsers first'}
              >
                <Trash2 size={12} />
              </button>
            ) : confirming ? (
              <span className="browser-profiles__delete-confirm">
                <button type="button" onClick={onCancelDelete}>Cancel</button>
                <button type="button" onClick={() => onDelete(profile.id)}>Delete</button>
              </span>
            ) : (
              <button
                type="button"
                aria-label={`Delete ${profile.label}`}
                disabled={busy !== null}
                onClick={() => onConfirmDelete(profile.id)}
              >
                <Trash2 size={12} />
              </button>
            )}
          </article>
        )
      })}
    </div>
  )
}

export function BrowserProfilesPanel({
  browsers,
  allBrowsers
}: {
  browsers: readonly BrowserProfileSurface[]
  allBrowsers: readonly BrowserProfileSurface[]
}) {
  const mounted = useRef(true)
  const importRequest = useRef(0)
  const [profiles, setProfiles] = useState<BrowserProfileSummary[] | null>(null)
  const [sources, setSources] = useState<BrowserProfileImportSourceSummary[] | null>(null)
  const [createLabel, setCreateLabel] = useState('')
  const [sourceToken, setSourceToken] = useState('')
  const [importLabel, setImportLabel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    void api.browser.listProfiles().then((next) => {
      if (mounted.current) setProfiles(next)
    }).catch((cause) => {
      if (mounted.current) setError(presentError(cause))
    })
    return () => {
      mounted.current = false
      importRequest.current += 1
    }
  }, [])

  async function createProfile(): Promise<void> {
    const label = createLabel.trim()
    if (!label || busy) return
    setBusy('create')
    setError(null)
    try {
      const created = await api.browser.createProfile(label)
      if (!mounted.current) return
      setProfiles((current) => [...(current ?? []), created])
      setCreateLabel('')
    } catch (cause) {
      if (mounted.current) setError(presentError(cause))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  async function openImport(): Promise<void> {
    if (busy) return
    const request = ++importRequest.current
    setBusy('detect')
    setError(null)
    setSources(null)
    setSourceToken('')
    setImportLabel('')
    try {
      const detected = await api.browser.detectProfileImportSources()
      if (!mounted.current || importRequest.current !== request) return
      setSources(detected)
    } catch (cause) {
      if (mounted.current && importRequest.current === request) {
        setError(presentError(cause))
      }
    } finally {
      if (mounted.current && importRequest.current === request) setBusy(null)
    }
  }

  function closeImport(): void {
    importRequest.current += 1
    setSources(null)
    setSourceToken('')
    setImportLabel('')
    if (busy === 'detect') setBusy(null)
  }

  function selectSource(token: string): void {
    setSourceToken(token)
    const source = sources?.find((candidate) => candidate.token === token)
    if (source) setImportLabel(`${source.browserLabel} — ${source.profileLabel}`)
  }

  async function importProfile(): Promise<void> {
    const label = importLabel.trim()
    if (!sourceToken || !label || busy) return
    setBusy('import')
    setError(null)
    try {
      const imported = await api.browser.importProfile(sourceToken, label)
      if (!mounted.current) return
      setProfiles((current) => [...(current ?? []), imported])
      closeImport()
    } catch (cause) {
      if (mounted.current) setError(presentError(cause))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  async function switchProfile(browserId: string, profileId: string): Promise<void> {
    if (busy) return
    setBusy(`switch:${browserId}`)
    setError(null)
    try {
      await api.browser.switchProfile(browserId, profileId)
    } catch (cause) {
      if (mounted.current) setError(presentError(cause))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  async function deleteProfile(profileId: string): Promise<void> {
    if (busy) return
    setBusy(`delete:${profileId}`)
    setError(null)
    try {
      await api.browser.deleteProfile(profileId)
      if (!mounted.current) return
      setProfiles((current) => current?.filter((profile) => profile.id !== profileId) ?? null)
      setConfirmDeleteId(null)
    } catch (cause) {
      if (mounted.current) setError(presentError(cause))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  return (
    <section className="browser-profiles" aria-label="Browser Profiles">
      <header>
        <UserRound size={14} />
        <span><strong>Profiles</strong><small>Isolated sessions owned by AgentMux.</small></span>
      </header>
      {profiles === null ? (
        <div className="browser-profiles__loading"><LoaderCircle className="spin" size={13} /> Loading Profiles…</div>
      ) : (
        <BrowserProfileCatalog
          profiles={profiles}
          browsers={allBrowsers}
          busy={busy}
          confirmDeleteId={confirmDeleteId}
          onConfirmDelete={setConfirmDeleteId}
          onCancelDelete={() => setConfirmDeleteId(null)}
          onDelete={(profileId) => void deleteProfile(profileId)}
        />
      )}

      <form className="browser-profiles__create" onSubmit={(event) => {
        event.preventDefault()
        void createProfile()
      }}>
        <input
          aria-label="New Browser Profile name"
          placeholder="New Profile name"
          value={createLabel}
          maxLength={128}
          disabled={profiles === null || busy !== null}
          onChange={(event) => setCreateLabel(event.target.value)}
        />
        <button type="submit" aria-label="Create Browser Profile" disabled={profiles === null || !createLabel.trim() || busy !== null}>
          {busy === 'create' ? <LoaderCircle className="spin" size={12} /> : <Plus size={13} />}
        </button>
      </form>

      {sources === null ? (
        <button className="small-button browser-profiles__import-open" type="button" disabled={profiles === null || busy !== null} onClick={() => void openImport()}>
          {busy === 'detect' ? <LoaderCircle className="spin" size={12} /> : <Download size={12} />}
          {busy === 'detect' ? 'Detecting…' : 'Import Profile…'}
        </button>
      ) : (
        <div className="browser-profiles__import" aria-label="Import Browser Profile">
          {sources.length === 0 ? <p>No supported Browser Profiles were detected.</p> : (
            <>
              <label>
                <span>Source</span>
                <select value={sourceToken} onChange={(event) => selectSource(event.target.value)}>
                  <option value="">Choose a Profile…</option>
                  {sources.map((source) => (
                    <option key={source.token} value={source.token}>{source.browserLabel} · {source.profileLabel}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>AgentMux Profile name</span>
                <input value={importLabel} maxLength={128} onChange={(event) => setImportLabel(event.target.value)} />
              </label>
            </>
          )}
          <div>
            <button className="small-button" type="button" disabled={busy === 'import'} onClick={closeImport}>Cancel</button>
            {sources.length > 0 ? (
              <button className="primary-button" type="button" disabled={!sourceToken || !importLabel.trim() || busy !== null} onClick={() => void importProfile()}>
                {busy === 'import' ? <LoaderCircle className="spin" size={12} /> : <Download size={12} />}
                {busy === 'import' ? 'Importing…' : 'Import'}
              </button>
            ) : null}
          </div>
        </div>
      )}

      {browsers.length > 0 ? (
        <div className="browser-profiles__browsers">
          <strong>Open Browsers</strong>
          {browsers.map((browser) => (
            <label key={browser.browserId}>
              <span><strong>{browser.title || 'New Browser'}</strong><small>{browser.url}</small></span>
              <select
                aria-label={`Profile for ${browser.title || browser.url}`}
                value={browser.profileId}
                disabled={profiles === null || busy !== null}
                onChange={(event) => void switchProfile(browser.browserId, event.target.value)}
              >
                {profiles?.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : null}
      {error ? <div className="surface-tool-error" role="alert">{error}</div> : null}
    </section>
  )
}
