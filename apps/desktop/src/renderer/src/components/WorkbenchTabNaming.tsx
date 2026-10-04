import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useEffect, useId, useRef, useState, type MouseEvent, type FocusEvent, type ReactNode, type RefObject } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { workbenchAgentFactsFor, workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import { agentDisplayName, workbenchSurfaces, type WorkbenchTab } from '../lib/workbench-tabs'
import { WindowOverlayPortal } from './WindowOverlayHost'
import type { RenderableServiceNotice } from '../lib/service-window-notice'

export type TabNameTarget = { kind: 'tab' | 'agent-session'; id: string }
export function tabRenameTargets(tab: WorkbenchTab, sessions: readonly SessionSnapshot[],
  names: Readonly<Record<string, string>>, timelines: Readonly<Record<string, AgentTimelineSnapshot>>): TabNameTarget[] {
  const surfaces = workbenchSurfaces(tab), only = surfaces.length === 1 ? surfaces[0] : undefined
  const confirmedAgent = only?.kind === 'agent' && sessions.some(session => session.kind === 'agent' && session.id === only.sessionId)
  const facts = confirmedAgent && only?.kind === 'agent' ? workbenchAgentFactsFor(sessions, names, timelines)(only.sessionId) : null
  const tabTarget: TabNameTarget = { kind: 'tab', id: tab.id }
  if (!facts || only?.kind !== 'agent' ||
    workbenchTabDisplayName(tab, sessions, names, timelines) !== agentDisplayName(facts)) return [tabTarget]
  // A derived Tab already follows its Agent. An explicit equal Tab name also needs its own edit.
  return [{ kind: 'agent-session', id: only.sessionId }, ...(tab.name ? [tabTarget] : [])]
}

type Rename = { token: object; value: string; label: string;
  targets: { target: TabNameTarget; revision: number }[]; completed: string[]; incomplete: RenderableServiceNotice | null }
const targetKey = (target: TabNameTarget) => `${target.kind}:${target.id}`
const targetLabel = (target: TabNameTarget) => target.kind === 'tab' ? 'Tab' : 'Agent'

function incompleteNameEdit(confirmed: readonly TabNameTarget[], unconfirmed: TabNameTarget, value: string | null): RenderableServiceNotice {
  const intended = value === null ? 'the default name' : JSON.stringify(value)
  return { kind: 'indeterminate', notice: {
    step: `${targetLabel(unconfirmed)} name change is unconfirmed`,
    mode: [...confirmed.map(target => `${targetLabel(target)} name confirmed as ${intended}.`),
      `${targetLabel(unconfirmed)} change to ${intended} has no confirmed result.`].join(' '),
    restore: 'Your draft and running Agent are kept. Review the current name and the original service notice before making a new edit.'
  } }
}

/** One editor, exact original targets, and an independent confirmed baseline for each name owner. */
export function useWorkbenchTabRename(input: {
  displayName: string; targets: readonly TabNameTarget[];
  revision(target: TabNameTarget): number;
  save(target: TabNameTarget, value: string | null, revision: number): Promise<boolean>;
}) {
  const [rename, setRename] = useState<Rename | null>(null)
  const saving = useRef(false)
  const activeToken = useRef<object | null>(null)
  useEffect(() => () => { activeToken.current = null }, [])
  const combined = input.targets.some(target => target.kind === 'agent-session')
  const label: 'Rename tab' | 'Rename tab and agent' = combined ? 'Rename tab and agent' : 'Rename tab'
  function begin() {
    const token = {}; activeToken.current = token
    setRename({ token, value: input.displayName, label,
      targets: input.targets.map(target => ({ target, revision: input.revision(target) })), completed: [], incomplete: null })
  }
  async function commit(trigger: 'submit' | 'blur' = 'submit') {
    if (!rename || activeToken.current !== rename.token || saving.current || trigger === 'blur' && rename.incomplete) return
    const submitted = rename, value = submitted.value.trim() || null
    const confirmed = submitted.targets.filter(item => submitted.completed.includes(targetKey(item.target))).map(item => item.target)
    saving.current = true
    try {
      for (const item of submitted.targets) {
        const key = targetKey(item.target)
        if (submitted.completed.includes(key)) continue
        if (activeToken.current !== submitted.token) return
        if (!await input.save(item.target, value, item.revision)) {
          setRename(current => current?.token === submitted.token ? {
            ...current, incomplete: incompleteNameEdit(confirmed, item.target, value)
          } : current)
          return
        }
        confirmed.push(item.target)
        setRename(current => current?.token !== submitted.token ? current : {
          ...current,
          targets: current.targets.map(entry => targetKey(entry.target) === key ? { ...entry, revision: item.revision + 1 } : entry),
          completed: current.value === submitted.value ? [...current.completed, key] : current.completed
        })
      }
      setRename(current => current?.token === submitted.token && current.value === submitted.value ? null : current)
    } finally { saving.current = false }
  }
  return { rename, label, begin, commit,
    cancel: () => { activeToken.current = null; setRename(null) },
    change: (value: string) => setRename(current => current ? { ...current, value, completed: [], incomplete: null } : null) }
}

/** Read-only feedback beside the original editor; the original name owner retains the result. */
export function WorkbenchTabRenameFeedback({ anchor, notice, children }: {
  anchor: RefObject<HTMLInputElement | null>; notice: RenderableServiceNotice | null; children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const input = anchor.current, surface = panel.current
    if (!notice || !input || !surface) return
    let disposed = false
    const update = async () => {
      const position = await computePosition(input, surface, { strategy: 'fixed', placement: 'bottom-start',
        middleware: [offset(8), flip(), shift({ padding: 8 })] })
      if (!disposed) Object.assign(surface.style, { left: `${position.x}px`, top: `${position.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(input, surface, () => { void update() })
    return () => { disposed = true; stop() }
  }, [anchor, notice])
  return notice ? <WindowOverlayPortal layer="service"><div ref={panel} data-state="open" className="workbench-tab-rename-feedback">{children}</div></WindowOverlayPortal> : null
}

/** A Tab's complete identity stays outside the strip's overflow, without activating the Tab. */
export function useWorkbenchTabNameTooltip(name: string, detail: string, suppressed: boolean) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const surface = useRef<HTMLDivElement>(null), id = useId()
  const visible = anchor !== null && !suppressed
  useEffect(() => {
    if (suppressed) setAnchor(null)
  }, [suppressed])
  useEffect(() => {
    if (!visible || !anchor || !surface.current) return
    let disposed = false
    const panel = surface.current
    const update = async () => {
      const position = await computePosition(anchor, panel, { strategy: 'fixed', placement: 'bottom-start',
        middleware: [offset(8), flip(), shift({ padding: 8 })] })
      if (!disposed) Object.assign(panel.style, { left: `${position.x}px`, top: `${position.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, panel, () => { void update() })
    const hide = () => setAnchor(null)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') hide() }
    window.addEventListener('blur', hide); document.addEventListener('visibilitychange', hide)
    window.addEventListener('keydown', key)
    return () => { disposed = true; stop(); window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', hide); window.removeEventListener('keydown', key) }
  }, [visible, anchor, name, detail])
  const show = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => { if (!suppressed) setAnchor(event.currentTarget) }
  return { props: { onMouseEnter: show, onMouseLeave: () => setAnchor(null), onFocus: show,
    onBlur: () => setAnchor(null), 'aria-describedby': visible ? id : undefined },
    content: visible ? <WindowOverlayPortal layer="tooltip"><div ref={surface} id={id} role="tooltip" className="workbench-tab-name-tooltip">
      <strong>{name}</strong>{detail ? <span>{detail}</span> : null}
    </div></WindowOverlayPortal> : null }
}
