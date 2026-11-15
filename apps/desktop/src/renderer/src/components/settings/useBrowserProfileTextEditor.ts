import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CompositionEvent, type FocusEvent, type KeyboardEvent } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import { browserProfiles } from '../../lib/browser-profiles'
import { profileTextValue, type createBrowserProfileTextDrafts, type ProfileTextDraft, type ProfileTextField } from '../../lib/browser-profile-text-drafts'

type TextControl = HTMLInputElement | HTMLTextAreaElement
type Drafts = ReturnType<typeof createBrowserProfileTextDrafts>

export function useBrowserProfileTextEditor<T extends TextControl>(profile: BrowserProfileSummary, field: ProfileTextField, drafts: Drafts, initiallyOpen: boolean, onSaved: () => void) {
  const entries = useSyncExternalStore(drafts.subscribe, () => drafts.get(profile.id)[field])
  const draft = entries?.[0]
  const [open, setOpen] = useState(initiallyOpen)
  const [review, setReview] = useState<{ draft: ProfileTextDraft; observed: BrowserProfileSummary } | null>(null)
  const mounted = useRef(false)
  const control = useRef<T>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const focus = useRef<'input' | 'opener' | null>(initiallyOpen ? 'input' : null)
  const openedProfile = useRef<BrowserProfileSummary | null>(initiallyOpen ? profile : null)
  const interaction = useRef({ focused: false, composing: false, blurAfterComposition: false, blurAfterSave: false, canSaveOnBlur: false })
  const live = interaction.current
  const editing = open || Boolean(draft)

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    if (focus.current === 'input' && control.current) {
      focus.current = null
      control.current.focus()
      if (field === 'label') control.current.select()
    } else if (focus.current === 'opener' && opener.current) {
      focus.current = null
      opener.current.focus({ preventScroll: true })
    }
  }, [editing, field])

  const start = () => {
    openedProfile.current = profile
    focus.current = 'input'
    setOpen(true)
  }
  const close = (focusOpener = false) => {
    openedProfile.current = null
    if (focusOpener) focus.current = 'opener'
    setOpen(false)
  }
  const discard = () => {
    drafts.discard(profile.id, field)
    live.blurAfterSave = false
    live.blurAfterComposition = false
    live.canSaveOnBlur = false
    setReview(null)
    close(true)
  }
  const finish = async (explicit = false, observed?: BrowserProfileSummary) => {
    if (live.composing) return
    const current = drafts.draft(profile.id, field)
    if (!current) { close(); return }
    // Restored input may predate an in-flight write's marker. A focus round trip cannot submit it.
    if (!explicit && !live.canSaveOnBlur) return
    if (drafts.isSaving(current)) { live.blurAfterSave = true; return }
    const wasEditedHere = live.canSaveOnBlur
    live.canSaveOnBlur = false
    const ok = await drafts.save(profile.id, field, observed)
    const queued = live.blurAfterSave
    live.blurAfterSave = false
    if (!mounted.current) return
    if (!ok) { live.canSaveOnBlur ||= wasEditedHere; return }
    const latest = drafts.draft(profile.id, field)
    if (!latest) {
      if (explicit || (!live.focused && !live.composing)) close(explicit)
      else openedProfile.current = null
      if (current.value.trim() !== current.baseline.value) onSaved()
    } else if (queued && !live.focused && !live.composing && latest.state === 'editing') {
      void finish()
    }
  }
  const checked = review?.draft === draft ? review?.observed : undefined

  return {
    editing, draft, control, opener, start, discard,
    hasEarlier: (entries?.length ?? 0) > 1,
    showEarlier: () => { live.canSaveOnBlur = false; drafts.showEarlier(profile.id, field) },
    value: draft?.value ?? profileTextValue(openedProfile.current ?? profile, field),
    change: (value: string) => { live.canSaveOnBlur = true; drafts.change(openedProfile.current ?? profile, field, value) },
    isSaving: draft ? drafts.isSaving(draft) : false,
    message: draft ? drafts.message(draft) : undefined,
    checked,
    retry: () => void finish(true, checked),
    async reload() {
      if (!draft) return
      await browserProfiles.refresh()
      const list = browserProfiles.get()
      const observed = list.error ? undefined : list.profiles?.find(value => value.id === profile.id)
      if (!observed || drafts.draft(profile.id, field) !== draft || !mounted.current) return
      if (draft.state === 'conflict') drafts.adoptBaseline(observed, field, draft)
      else setReview({ draft, observed })
    },
    onFocus() { live.focused = true; setOpen(true) },
    onCompositionStart() { live.composing = true },
    onCompositionEnd(event: CompositionEvent<T>) {
      live.composing = false
      if (!live.blurAfterComposition) return
      live.blurAfterComposition = false
      const input = event.currentTarget
      // The native final input may arrive after compositionend but before this microtask.
      queueMicrotask(() => { if (input.isConnected && !live.focused) void finish() })
    },
    onBlur(event: FocusEvent<T>) {
      live.focused = false
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.browser-profile-editor__error')) return
      if (live.composing) { live.blurAfterComposition = true; return }
      void finish()
    },
    onKeyDown(event: KeyboardEvent<T>) {
      if (live.composing || isImeOwnedKeyboardEvent(event)) { event.stopPropagation(); return }
      if (event.key === 'Enter' && field === 'label') { event.preventDefault(); void finish(true) }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); discard() }
    }
  }
}
