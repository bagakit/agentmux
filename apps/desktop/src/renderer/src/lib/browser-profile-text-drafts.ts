import { describeError, presentError } from '@agentmux/client-ui/error-presentation'
import type { BrowserProfileSummary } from '../../../shared/contracts'
import { api } from './api'
import { desktopUserFragments } from './desktop-user-state'

export type ProfileTextField = 'label' | 'notes'
type Baseline = { value: string; revision: string }
export type ProfileTextDraft = {
  value: string
  baseline: Baseline
  state: 'editing' | 'saving' | 'conflict' | 'unconfirmed' | 'failed'
  attempt?: Baseline
}
type ProfileDrafts = Partial<Record<ProfileTextField, readonly ProfileTextDraft[]>>
export type BrowserProfileTextDrafts = Readonly<Record<string, ProfileDrafts>>

const member = 'browserProfileTextDrafts' as const
const fields = ['label', 'notes'] as const
const empty: ProfileDrafts = {}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hasOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const isBaseline = (value: unknown) => isRecord(value) && hasOnly(value, ['value', 'revision']) && typeof value.value === 'string' && typeof value.revision === 'string' && value.revision.length > 0
const isDraft = (value: unknown) => isRecord(value) && hasOnly(value, ['value', 'baseline', 'state', 'attempt']) &&
  typeof value.value === 'string' && isBaseline(value.baseline) &&
  (value.state === 'saving' || value.state === 'unconfirmed' ? isBaseline(value.attempt) :
    (value.state === 'editing' || value.state === 'conflict' || value.state === 'failed') && value.attempt === undefined)

function validate(value: BrowserProfileTextDrafts | null | undefined) {
  if (value == null) return
  if (!isRecord(value) || Object.entries(value).some(([id, drafts]) => !id || !isRecord(drafts) ||
    !hasOnly(drafts, [...fields]) || Object.values(drafts).some(entries => !Array.isArray(entries) || !entries.length || !entries.every(isDraft)))) {
    throw new Error('The original Profile text drafts could not be read. Their saved data is kept.')
  }
}

export const profileTextValue = (profile: BrowserProfileSummary, field: ProfileTextField) => profile[field] ?? ''
const baseline = (profile: BrowserProfileSummary, field: ProfileTextField): Baseline => ({ value: profileTextValue(profile, field), revision: profile.revision })

/** Input only. The original Desktop document owns durability, and the Profile owner confirms each CAS. */
export function createBrowserProfileTextDrafts() {
  let profiles: BrowserProfileTextDrafts = {}
  let ready = false
  let unqueued = false
  let loading: Promise<void> | undefined
  let storageError: string | null = null
  const listeners = new Set<() => void>()
  const requests = new Set<Baseline>()
  const messages = new WeakMap<ProfileTextDraft, string>()
  const changed = () => { for (const listener of listeners) listener() }
  const get = (id: string) => Object.hasOwn(profiles, id) ? profiles[id]! : empty
  const draft = (id: string, field: ProfileTextField) => get(id)[field]?.[0]
  const persist = () => {
    if (!ready || !unqueued) return
    desktopUserFragments.write(member, profiles)
    unqueued = false
  }
  const storageFailed = (cause: unknown) => { storageError = presentError(cause); changed() }
  const put = (id: string, field: ProfileTextField, entries: readonly ProfileTextDraft[]) => {
    const row = { ...get(id) }
    if (entries.length) row[field] = entries
    else delete row[field]
    const next = { ...profiles, [id]: row }
    if (!row.label && !row.notes) delete next[id]
    profiles = next
    unqueued = true
    try { persist() } catch (cause) { storageFailed(cause) }
    changed()
  }
  const replace = (id: string, field: ProfileTextField, value?: ProfileTextDraft) => {
    const previous = get(id)[field]?.slice(1) ?? []
    put(id, field, value ? [value, ...previous] : previous)
  }
  const load = () => loading ??= (async () => {
    try {
      const wasReady = ready
      const original = await desktopUserFragments.load(member, validate)
      if (!ready) {
        const local = profiles, merged = { ...original }
        for (const [id, localFields] of Object.entries(local)) {
          const saved = Object.hasOwn(merged, id) ? merged[id] : undefined
          const next = { ...saved }
          // Input typed while the original read was pending keeps its own baseline and the older draft.
          for (const field of fields) if (localFields[field]) next[field] = [...localFields[field], ...saved?.[field] ?? []]
          merged[id] = next
        }
        profiles = merged
        ready = true
        if (!Object.keys(local).length) unqueued = false
      }
      persist()
      if (!wasReady) storageError = null
    } catch (cause) { storageFailed(cause) }
    finally { loading = undefined; changed() }
  })()
  const checkpoint = async () => {
    await load()
    if (!ready) return
    try { persist(); await desktopUserFragments.checkpoint(member); storageError = null; changed() }
    catch (cause) { storageFailed(cause) }
  }
  const isSaving = (value: ProfileTextDraft) => value.attempt !== undefined && requests.has(value.attempt)

  return {
    get, draft, load, checkpoint, isSaving,
    pending: () => unqueued,
    async checkpointBeforeExit() {
      if (!unqueued) return
      await checkpoint()
      if (unqueued || storageError) throw new Error(storageError ?? 'Current Profile text drafts are not yet confirmed.')
    },
    storageError: () => storageError,
    message: (value: ProfileTextDraft) => messages.get(value),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    change(profile: BrowserProfileSummary, field: ProfileTextField, value: string) {
      const previous = draft(profile.id, field)
      const next: ProfileTextDraft = previous ? { ...previous, value } : { value, baseline: baseline(profile, field), state: 'editing' }
      const message = previous && messages.get(previous)
      if (message) messages.set(next, message)
      replace(profile.id, field, next)
    },
    discard(id: string, field: ProfileTextField) {
      if (!draft(id, field)) return
      replace(id, field)
      void checkpoint()
    },
    showEarlier(id: string, field: ProfileTextField) {
      const [current, ...earlier] = get(id)[field] ?? []
      if (current && !isSaving(current) && earlier.length) put(id, field, [...earlier, current])
    },
    adoptBaseline(profile: BrowserProfileSummary, field: ProfileTextField, previous: ProfileTextDraft) {
      if (draft(profile.id, field) !== previous || isSaving(previous)) return
      if (previous.state === 'conflict') replace(profile.id, field, { ...previous, baseline: baseline(profile, field), state: 'editing' })
    },
    async save(id: string, field: ProfileTextField, reviewed?: BrowserProfileSummary) {
      const original = draft(id, field)
      if (!original || isSaving(original) || original.state === 'conflict') return false
      const unconfirmed = original.state === 'saving' || original.state === 'unconfirmed'
      if (unconfirmed && reviewed?.id !== id) return false
      const base = reviewed ? baseline(reviewed, field) : original.baseline
      const value = original.value.trim()
      if (field === 'label' && !value) return false
      if (value === base.value) {
        if (unconfirmed) return false
        replace(id, field)
        return true
      }
      const attempt = { value, revision: base.revision }
      requests.add(attempt)
      const submitted: ProfileTextDraft = { ...original, state: 'saving', attempt }
      replace(id, field, submitted)
      try {
        const saved = await api.browser.updateProfile(id, field === 'label' ? { label: value } : { notes: value }, attempt.revision)
        if (saved.id !== id || profileTextValue(saved, field) !== value) throw new Error('The received Profile differs from this save request.')
        const latest = draft(id, field)
        if (latest?.attempt === attempt) {
          replace(id, field, latest === submitted ? undefined : { value: latest.value, baseline: baseline(saved, field), state: 'editing' })
        }
        return true
      } catch (cause) {
        const latest = draft(id, field)
        if (latest?.attempt === attempt) {
          const code = describeError(cause).code
          const state = code === 'BROWSER_PROFILE_REVISION_CONFLICT' ? 'conflict' :
            !code || code === 'BROWSER_PROFILE_WRITE_UNCONFIRMED' ? 'unconfirmed' : 'failed'
          const next: ProfileTextDraft = { value: latest.value, baseline: base, state, ...(state === 'unconfirmed' ? { attempt } : {}) }
          messages.set(next, presentError(cause))
          replace(id, field, next)
        }
        return false
      } finally {
        requests.delete(attempt)
        changed()
      }
    }
  }
}

export const browserProfileTextDrafts = createBrowserProfileTextDrafts()
