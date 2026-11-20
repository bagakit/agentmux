import { useEffect, useRef, useState } from 'react'
import { describeError, presentError } from '@agentmux/client-ui/error-presentation'
import type { BrowserProfileEnvironment } from '@agentmux/core/control'
import { Button } from '@agentmux/client-ui/components/Button'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { browserProfiles } from '../../lib/browser-profiles'
import {
  environmentDraftKey,
  environmentFields,
  environmentFromFields,
  type ProfileEnvironmentDraft,
  type ProfileEnvironmentFields
} from '../../lib/browser-profile-environment-form'
import { profileEnvironmentDrafts } from '../../lib/browser-profile-environment-drafts'
import { ProfileEnvironmentApplication } from './ProfileEnvironmentApplication'
import { ProfileEnvironmentFieldsEditor, ProfileFingerprintFields } from './ProfileEnvironmentFieldsEditor'
import './settings-browser-profile-environment.css'

type Model = ProfileEnvironmentDraft & { profileId: string; dirty: boolean }
const initial = (profile: BrowserProfileSummary): Model => ({
  profileId: profile.id,
  baseRevision: profile.revision,
  fields: environmentFields(profile.environment),
  dirty: false
})
/** Saved settings and native application are read from their original Profile; this form owns only input. */
export function ProfileEnvironmentEditor({ profile }: { profile: BrowserProfileSummary }) {
  const [model, setModel] = useState<Model>(() => initial(profile)),
    current = useRef(model),
    latestProfile = useRef(profile)
  const [storageError, setStorageError] = useState<string | null>(null),
    [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null)
  const [notice, setNotice] = useState<string | null>(null),
    [loadingDraft, setLoadingDraft] = useState(false),
    [retained, setRetained] = useState<ProfileEnvironmentDraft[]>([])
  const [busy, setBusy] = useState(false),
    request = useRef<{ profileId: string } | null>(null),
    mounted = useRef(true),
    interaction = useRef(0)
  current.current = model
  latestProfile.current = profile
  if (model.profileId !== profile.id) {
    const next = initial(profile)
    current.current = next
    setModel(next)
  }
  const savedKey = JSON.stringify(profile.environment ?? null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const original = current.current
    if (original.profileId === profile.id && !original.dirty) {
      const next = initial(profile)
      current.current = next
      setModel(next)
    }
  }, [profile.id, profile.revision, savedKey])
  const install = (next: Model) => {
    current.current = next
    setModel(next)
  }
  const stash = (next: Model, earlier?: ProfileEnvironmentDraft) => {
    try {
      profileEnvironmentDrafts.write(
        next.profileId,
        { baseRevision: next.baseRevision, fields: next.fields },
        earlier
      )
      setRetained(profileEnvironmentDrafts.get(next.profileId)?.retained ?? [])
      return true
    } catch (cause) {
      setStorageError(presentError(cause))
      return false
    }
  }
  const loadDraft = async (confirm = false) => {
    const id = profile.id,
      startedAt = interaction.current
    setLoadingDraft(true)
    try {
      await profileEnvironmentDrafts.load()
      if (!mounted.current || current.current.profileId !== id) return
      const record = profileEnvironmentDrafts.get(id),
        live = current.current
      if (live.dirty) {
        if (!stash(live, record?.active ?? undefined)) return
      } else if (record?.active) {
        if (interaction.current === startedAt) install({ ...record.active, profileId: id, dirty: true })
        else profileEnvironmentDrafts.retainActive(id)
      }
      // A readable cache alone cannot settle an earlier failed disk write.
      if (live.dirty || confirm) await profileEnvironmentDrafts.checkpoint()
      if (!mounted.current || current.current.profileId !== id) return
      setRetained(profileEnvironmentDrafts.get(id)?.retained ?? [])
      setStorageError(null)
    } catch (cause) {
      if (mounted.current && current.current.profileId === id) setStorageError(presentError(cause))
    } finally {
      if (mounted.current && current.current.profileId === id) setLoadingDraft(false)
    }
  }
  useEffect(() => {
    void loadDraft()
  }, [profile.id])
  const checkpoint = () => {
    void profileEnvironmentDrafts.checkpoint().then(
      () => {
        if (mounted.current) setStorageError(null)
      },
      (cause) => {
        if (mounted.current) setStorageError(presentError(cause))
      }
    )
  }
  useEffect(() => {
    const failed = () => {
      if (current.current.dirty)
        setStorageError(
          'Desktop draft storage is unconfirmed. Your current input stays here; retry saving the draft.'
        )
    }
    window.addEventListener('agentmux-workbench-save-error', failed)
    return () => window.removeEventListener('agentmux-workbench-save-error', failed)
  }, [])
  const change = (patch: Partial<ProfileEnvironmentFields>) => {
    interaction.current++
    const next = { ...current.current, fields: { ...current.current.fields, ...patch }, dirty: true }
    install(next)
    setSaveError(null)
    setNotice(null)
    stash(next)
  }
  const useSaved = () => {
    interaction.current++
    const next = initial(latestProfile.current)
    install(next)
    setSaveError(null)
    setNotice(null)
    try {
      profileEnvironmentDrafts.discard(next.profileId)
      checkpoint()
    } catch (cause) {
      setStorageError(presentError(cause))
    }
  }
  let problem: string | null = null
  try {
    environmentFromFields(model.fields)
  } catch (cause) {
    problem = presentError(cause)
  }
  const apply = async (reapply = false) => {
    if (request.current?.profileId === profile.id) return
    const owner = latestProfile.current,
      live = current.current,
      id = owner.id,
      submitted: ProfileEnvironmentDraft = {
        baseRevision: reapply ? owner.revision : live.baseRevision,
        fields: structuredClone(live.fields)
      }
    let value: BrowserProfileEnvironment | null
    try {
      value = reapply ? (owner.environment ?? null) : environmentFromFields(submitted.fields)
    } catch (cause) {
      setSaveError({ message: presentError(cause), conflict: false })
      return
    }
    const admission = { profileId: id }
    request.current = admission
    setBusy(true)
    setSaveError(null)
    setNotice(null)
    let saved: BrowserProfileSummary
    try {
      saved = await api.browser.updateProfile(id, { environment: value }, submitted.baseRevision)
    } catch (cause) {
      if (mounted.current && current.current.profileId === id)
        setSaveError({
          message: presentError(cause),
          conflict: describeError(cause).code === 'BROWSER_PROFILE_REVISION_CONFLICT'
        })
      if (request.current === admission) {
        request.current = null
        if (mounted.current) setBusy(false)
      }
      return
    }
    if (mounted.current && current.current.profileId === id) {
      interaction.current++
      const newer = current.current
      if (!reapply && (!newer.dirty || environmentDraftKey(newer) === environmentDraftKey(submitted))) {
        const observed = latestProfile.current
        install(
          initial(
            observed.revision !== owner.revision &&
              observed.revision !== submitted.baseRevision &&
              observed.revision !== saved.revision
              ? observed
              : saved
          )
        )
      } else if (newer.dirty && (!reapply || newer.baseRevision === submitted.baseRevision)) {
        const next = { ...newer, baseRevision: saved.revision }
        install(next)
        stash(next)
      }
      setNotice(
        !reapply && current.current.dirty ? 'Earlier settings saved. You have new edits.' : 'Settings saved.'
      )
    }
    if (!reapply) {
      try {
        profileEnvironmentDrafts.clearSubmitted(id, submitted)
        await profileEnvironmentDrafts.checkpoint()
      } catch (cause) {
        if (mounted.current && current.current.profileId === id) setStorageError(presentError(cause))
      }
    }
    void browserProfiles.refresh()
    if (request.current === admission) {
      request.current = null
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section
      className="browser-profile-editor__section profile-environment"
      aria-label="Environment"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) checkpoint()
      }}
    >
      <div className="profile-environment__heading">
        <h4>Environment</h4>
        <button
          type="button"
          className="browser-profile-editor__link"
          onClick={() => {
            change(environmentFields())
          }}
        >
          Restore defaults
        </button>
      </div>
      <p className="profile-environment__intro">Region and browser identity for this Profile.</p>
      <ProfileEnvironmentFieldsEditor fields={model.fields} change={change} />
      <ProfileFingerprintFields value={model.fields.fingerprint} onChange={fingerprint => change({ fingerprint })} />
      {model.dirty ? (
        <div className="profile-environment__actions">
          <span>Unsaved changes</span>
          <Button type="button" onClick={useSaved}>
            Revert
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !!problem}
            onClick={() => void apply()}
          >
            {busy ? 'Saving…' : 'Apply environment'}
          </Button>
        </div>
      ) : null}
      {model.dirty && problem ? (
        <p className="browser-profile-editor__error" role="alert">
          {problem}
        </p>
      ) : null}
      {saveError ? (
        <p className="browser-profile-editor__error" role="alert">
          {saveError.message}
          {saveError.conflict ? (
            <>
              {' '}
              <button
                type="button"
                className="browser-profile-editor__link"
                onClick={() => void browserProfiles.refresh()}
              >
                Refresh saved settings
              </button>{' '}
              <button
                type="button"
                className="browser-profile-editor__link"
                onClick={() => {
                  const next = { ...current.current, baseRevision: latestProfile.current.revision }
                  install(next)
                  stash(next)
                  setSaveError(null)
                }}
              >
                Keep edits with current version
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {notice ? (
        <p className="browser-profile-editor__quiet" role="status">
          {notice}
        </p>
      ) : null}
      {storageError ? (
        <p className="browser-profile-editor__error" role="status">
          Draft storage unconfirmed. {storageError}{' '}
          <button
            type="button"
            className="browser-profile-editor__link"
            disabled={loadingDraft}
            onClick={() => void loadDraft(true)}
          >
            {loadingDraft ? 'Retrying…' : 'Retry draft storage'}
          </button>
        </p>
      ) : null}
      {retained.length ? (
        <details>
          <summary>
            {retained.length} earlier {retained.length === 1 ? 'draft' : 'drafts'}
          </summary>
          {retained.map((draft, index) => (
            <p className="browser-profile-editor__quiet" key={index}>
              Draft {index + 1} · {draft.fields.timeZone || draft.fields.locale || 'Environment edits'}{' '}
              <button
                type="button"
                className="browser-profile-editor__link"
                onClick={() => {
                  try {
                    interaction.current++
                    const restored = profileEnvironmentDrafts.restore(profile.id, index)
                    install({ ...restored, profileId: profile.id, dirty: true })
                    setRetained(profileEnvironmentDrafts.get(profile.id)?.retained ?? [])
                    checkpoint()
                  } catch (cause) {
                    setStorageError(presentError(cause))
                  }
                }}
              >
                Restore draft {index + 1}
              </button>
            </p>
          ))}
        </details>
      ) : null}
      <ProfileEnvironmentApplication profile={profile} busy={busy} onReapply={() => void apply(true)} />
      <p className="profile-environment__limits">
        TLS, device memory and engine-wide fingerprint overrides are unsupported.
      </p>
    </section>
  )
}
