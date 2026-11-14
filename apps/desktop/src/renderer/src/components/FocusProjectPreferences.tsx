import '../styles/focus-project-menu.css'
import * as Popover from '@agentmux/client-ui/components/Modal'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { FOCUS_PROJECT_COLORS, focusProjectPreference, focusProjectTint, type FocusProjectPreference } from '../../../shared/focus-project-preferences'
import { configValuesEqual } from '../../../shared/config-edit'
import { saveFocusPreferences } from '../lib/focus-preferences'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { DocumentOverlayPortal } from './WindowOverlayHost'

/** Draft stays at its exact original project on a failed save; no workspace or runtime writes. */
export type FocusDiscussionSlot = { active: boolean; container: HTMLElement | null }
export function FocusProjectPreferences({ projectKey, name, actions, discussion, active = true, collection = false }: {
  active?: boolean; projectKey?: string; name: string; collection?: boolean; actions?: ReactNode; discussion?: ((state: FocusDiscussionSlot) => ReactNode) | undefined
}) {
  const projects = useAppStore(state => state.config?.focus?.projects)
  const saved = focusProjectPreference(projectKey ?? '', projects ?? [])
  const subject = collection ? 'Collection' : projectKey ? 'Project' : 'Container'
  const appearanceLabel = `${subject} appearance`
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(saved)
  const effectiveOpen = open && active
  const baseline = useRef<readonly FocusProjectPreference[]>([])
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const generation = useRef(0), draftVersion = useRef(0), inFlight = useRef(false), resumeDraft = useRef(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [discussionVisited, setDiscussionVisited] = useState(false)
  const [discussionHost, setDiscussionHost] = useState<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null), escape = useRef(false)
  const panel = useRef<HTMLDivElement>(null)
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null)
  const attachPanel = useCallback((element: HTMLDivElement | null) => { panel.current = element; setPanelElement(element) }, [])
  useEffect(() => { if (!active && open) { resumeDraft.current = true; begin(false) } }, [active, open])
  useLayoutEffect(() => {
    const anchor = trigger.current, content = panel.current
    if (!effectiveOpen || !anchor || !content) return
    let attached = true
    const update = async () => {
      const result = await computePosition(anchor, content, { strategy: 'fixed', placement: 'bottom-start', middleware: [offset(5), flip(), shift({ padding: 8, crossAxis: true })] })
      if (attached) Object.assign(content.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, content, () => { void update() })
    return () => { attached = false; stop() }
  }, [effectiveOpen, panelElement])
  function begin(next: boolean) {
    ++generation.current
    if (next) {
      setDiscussionVisited(true)
      if (!resumeDraft.current) { setAppearanceOpen(false); baseline.current = projects ?? []; setDraft(saved); setError(null); setNotice(null); draftVersion.current = 0 }
      resumeDraft.current = false
    }
    setOpen(next)
  }
  function edit(next: FocusProjectPreference) { ++draftVersion.current; setDraft(next) }
  function reviewCurrent() {
    const current = useAppStore.getState().config?.focus?.projects ?? []
    const previous = focusProjectPreference(projectKey ?? '', baseline.current)
    const value = focusProjectPreference(projectKey ?? '', current)
    edit({ ...value, pinned: draft.pinned !== previous.pinned ? draft.pinned : value.pinned,
      note: draft.note !== previous.note ? draft.note : value.note, color: draft.color !== previous.color ? draft.color : value.color,
      collapsed: draft.collapsed !== previous.collapsed ? draft.collapsed : value.collapsed })
    baseline.current = current
    setNotice(projectKey ? `Currently saved: ${value.pinned ? 'pinned' : 'unpinned'} · ${value.color}${value.note ? ' · ' + value.note : ' · no note'}. Your draft is kept; save to apply it.` : 'Current settings loaded. Your changes are kept; save to apply them.')
    setError(null)
  }
  async function save() {
    if (inFlight.current) return
    inFlight.current = true
    const token = generation.current, version = draftVersion.current
    setPending(true); setError(null); setNotice(null)
    const original = baseline.current
    const next = configValuesEqual(draft, focusProjectPreference(projectKey ?? '', original)) ? original : original.some(item => item.key === projectKey) ? original.map(item => item.key === projectKey ? draft : item) : [...original, draft]
    try {
      await saveFocusPreferences({ projects: next }, { projects: original })
      if (generation.current !== token) return
      baseline.current = useAppStore.getState().config?.focus?.projects ?? next
      if (draftVersion.current !== version) { setNotice('Earlier changes saved. Your newer edits are kept.'); return }
      const returnFocus = Boolean(panel.current?.contains(panel.current.ownerDocument.activeElement))
      begin(false); if (returnFocus) trigger.current?.focus({ preventScroll: true })
    }
    catch (cause) { if (generation.current === token) setError(presentError(cause)) }
    finally { inFlight.current = false; setPending(false) }
  }
  return <><Popover.Root modal={false} open={effectiveOpen} onOpenChange={begin}>
    <Popover.Trigger asChild><button ref={trigger} type="button" className={`icon-button focus-project-preferences__trigger${effectiveOpen ? ' is-menu-open' : ''}`} aria-label={`${subject} preferences · ${name}`} title={collection ? 'Collection actions and pin' : projectKey ? 'Project actions, pin, note and color' : 'Collection actions'}><SemanticIcon name="action.more" size={13} /></button></Popover.Trigger>
    <DocumentOverlayPortal component={Popover.Portal}><Popover.Content ref={attachPanel} className="tab-context-menu focus-project-preferences" data-focus-project-preferences="" aria-describedby={undefined} style={{ position: 'fixed', visibility: 'hidden' }}
      onEscapeKeyDown={() => { escape.current = true }} onCloseAutoFocus={event => { event.preventDefault(); if (escape.current) trigger.current?.focus({ preventScroll: true }); escape.current = false }}>
      <Popover.Title className="focus-project-preferences__name">{name}</Popover.Title>
      {actions}
      {discussion ? <div ref={setDiscussionHost} data-focus-group-discussion-host="" /> : null}
      {error ? <div role="status" className="focus-project-preferences__error">{error}<button type="button" className="small-button" onClick={reviewCurrent} aria-label={`Review current ${subject.toLowerCase()} preferences`}>Review current settings</button></div> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {projectKey ? <>
        <button type="button" className="tab-context-menu__item tab-context-menu__item--quiet focus-project-menu-action" aria-expanded={appearanceOpen} aria-label={appearanceLabel} aria-busy={pending || undefined} onClick={() => setAppearanceOpen(value => !value)}><SemanticIcon name={collection ? 'action.pin' : 'appearance.theme'} size={13} /><span>{pending ? `${appearanceLabel} · Saving…` : appearanceLabel}</span><SemanticIcon name="navigation.disclosure" size={11} /></button>
        {appearanceOpen ? <div className="focus-project-preferences__editor" data-focus-project-appearance="">
          <label className="focus-project-preferences__pin"><input type="checkbox" aria-label={`Pin ${subject.toLowerCase()}`} checked={draft.pinned} onChange={event => edit({ ...draft, pinned: event.target.checked })} />Pin {subject.toLowerCase()}</label>
          {!collection ? <><label className="focus-project-preferences__note"><span>Note</span><input aria-label="Project note" value={draft.note} placeholder="A familiar reminder" onChange={event => edit({ ...draft, note: event.target.value })} /></label>
          <div role="group" aria-label="Project background color" className="focus-project-preferences__color-row"><span>Color</span><div className="focus-project-preferences__colors">{FOCUS_PROJECT_COLORS.map(color => <button type="button" key={color} aria-label={`Project color · ${color}`} title={color} aria-pressed={draft.color === color}
            style={{ background: `color-mix(in srgb, ${focusProjectTint(color)} 26%, var(--surface-1))` }} onClick={() => edit({ ...draft, color })}>{draft.color === color ? <SemanticIcon name="status.selected" size={13} /> : null}</button>)}</div></div></> : null}
          <div className="focus-project-preferences__actions"><button type="button" className="small-button" onClick={() => begin(false)}>Cancel</button><button type="button" className="small-button" disabled={pending} onClick={() => void save()} aria-label={`Save ${subject.toLowerCase()} preferences`}>{pending ? 'Saving…' : error ? 'Retry save' : 'Save'}</button></div>
        </div> : null}
      </> : collection ? <p className="focus-project-preferences__notice">Pin needs a confirmed Collection. Original members and work surfaces remain available.</p> : null}

    </Popover.Content></DocumentOverlayPortal>
  </Popover.Root>{discussionVisited ? discussion?.({ active: effectiveOpen, container: effectiveOpen ? discussionHost : null }) : null}</>
}
