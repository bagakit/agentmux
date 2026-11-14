import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { Button } from '@agentmux/client-ui/components/Button'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { AgentFocusHistoryEntry } from '../lib/agent-focus'
import type { FocusHistoryCatalogue } from '../lib/focus-history-sources'
import type { createFocusTimeFormatters } from '../lib/focus-timeline-ruler'
import type { usePathDisplay } from '../hooks/usePathDisplay'
import type { TakeoverSource } from '../lib/session-takeover'
import { useAppStore } from '../store'
import { AgentSessionActionSurface, AgentSessionReadingSurface } from './AgentSessionReadingSurface'
import { ResolvedAgentAvatar } from './AgentAvatar'
import { useSpaceObjectMenu } from './SpaceObjectContextMenu'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { FocusWorkspaceStage } from './FocusWorkspaceStage'
import { SessionTakeoverSurface } from './SessionTakeoverSurface'

const HistoryIcon = semanticIconComponent('object.history')
const PreviewIcon = semanticIconComponent('object.conversation')
const ResumeIcon = semanticIconComponent('action.resume-session')
const TimelineIcon = semanticIconComponent('object.activity')
const TakeoverIcon = semanticIconComponent('action.take-over')

function address(entry: AgentFocusHistoryEntry) {
  return JSON.stringify([entry.identity?.source?.runtimeId ?? null, entry.identity?.hostId, entry.sessionId])
}

type Preview = { entry: AgentFocusHistoryEntry; trigger: HTMLButtonElement | null; detail: string }
type SavedHistoryActions = {
  preview(value: Preview): void
  getRestore(entry: AgentFocusHistoryEntry): 'open' | 'resume' | 'check' | undefined
  restore(entry: AgentFocusHistoryEntry): Promise<void>
  canTakeOver(entry: AgentFocusHistoryEntry): boolean
  takeOver(value: Preview): void
}
const SavedHistoryContext = createContext<RefObject<SavedHistoryActions | null> | null>(null)

export function FocusSavedHistory({ catalogue, visible, children }: {
  catalogue: FocusHistoryCatalogue; visible: boolean; children: ReactNode
}) {
  const [preview, setPreview] = useState<(Preview & { conversation?: boolean }) | null>(null)
  const [takeover, setTakeover] = useState<{ source: TakeoverSource; trigger: HTMLButtonElement | null } | null>(null)
  const actionsRef = useRef<SavedHistoryActions | null>(null)
  const active = useRef(visible)
  const inFlight = useRef(new Set<string>())
  const intents = useRef(new Map<string, string>())
  useEffect(() => {
    active.current = visible
    if (!visible) { setPreview(null); setTakeover(null) }
    return () => { active.current = false }
  }, [visible])
  const sources = useMemo(() => {
    const byAddress = new Map<string, AgentSessionHistoryDescriptor | null>()
    for (const source of catalogue.sources) {
      const key = JSON.stringify([null, source.hostId, source.agentSessionId])
      byAddress.set(key, byAddress.has(key) ? null : source)
    }
    return byAddress
  }, [catalogue.sources])
  const originalSession = useCallback((entry: AgentFocusHistoryEntry, state = useAppStore.getState()) => {
    const key = address(entry)
    const hostId = entry.identity?.hostId
    if (!hostId || entry.identity?.source) return undefined
    const views = state.sessions.filter(session => session.id === entry.sessionId)
    const saved = state.recoveryCandidates.filter(candidate => candidate.agentSessionId === entry.sessionId)
    if (views.length > 1 || views.some(view => view.kind !== 'agent' || view.control.hostId !== hostId ||
      view.control.agentSessionId !== entry.sessionId) || saved.length > 1 || saved.some(candidate => candidate.hostId !== hostId)) return undefined
    const source = sources.get(key)
    if (source?.state === 'deleted') return undefined
    const view = views[0]?.kind === 'agent' ? views[0] : undefined
    return { view, candidate: saved[0], source }
  }, [sources])

  const restoreTarget = useCallback((entry: AgentFocusHistoryEntry, state = useAppStore.getState()) => {
    const original = originalSession(entry, state)
    if (!original) return undefined
    const { view, candidate, source } = original
    const key = address(entry)
    if (view) return { kind: view.processState === 'running' ? 'open' as const : 'resume' as const }
    if (source?.state === 'retired' && source.retiredAt !== undefined) {
      if (source.pendingReopen && !source.pendingReopen.operationId && !intents.current.has(key)) return undefined
      return { kind: intents.current.has(key) || source.pendingReopen ? 'check' as const : 'resume' as const, source }
    }
    if (candidate) return { kind: 'resume' as const }
    return undefined
  }, [originalSession])

  const takeoverSource = useCallback((entry: AgentFocusHistoryEntry): TakeoverSource | undefined => {
    const original = originalSession(entry)
    if (!original) return undefined
    const { view, candidate, source } = original
    const facts = view ?? candidate ?? source?.history
    const hostId = entry.identity?.hostId
    if (!hostId || !facts) return undefined
    const details = { hostId, agentSessionId: entry.sessionId, cwd: facts.workspacePath, executorId: facts.executorId,
      label: entry.identity?.name || entry.sessionId, diagnostic: 'Original saved Focus task', origin: {} }
    return view ? { ...details, kind: 'session', presentationSessionId: view.id, expectedRun: view.control.run }
      : { ...details, kind: 'saved' }
  }, [originalSession])

  const refresh = catalogue.refresh
  const restore = useCallback(async (entry: AgentFocusHistoryEntry) => {
    const key = address(entry), before = useAppStore.getState()
    const original = restoreTarget(entry, before)
    if (!active.current || inFlight.current.has(key) || !original) return
    inFlight.current.add(key)
    try {
      if (original.kind === 'open') { before.selectSession(entry.sessionId); return }
      if (original.source) {
        const { source } = original
        const operationId = intents.current.get(key) ?? source.pendingReopen?.operationId ?? crypto.randomUUID()
        intents.current.set(key, operationId)
        await before.reopenRetiredSession(source, operationId, original.kind === 'check', () => {
          const current = useAppStore.getState()
          return active.current && current.mainSurface === before.mainSurface &&
            current.workbenchSpaceSelection === before.workbenchSpaceSelection && current.agentFocus === before.agentFocus
        })
        intents.current.delete(key)
        refresh()
      } else {
        const recovered = await before.recoverSession(entry.sessionId)
        const current = useAppStore.getState()
        if (recovered && active.current && current.mainSurface === before.mainSurface &&
          current.workbenchSpaceSelection === before.workbenchSpaceSelection && current.agentFocus === before.agentFocus) current.selectSession(entry.sessionId)
      }
    } catch (error) {
      if (error instanceof Error && 'controlFailure' in error &&
        (error.controlFailure as { disposition?: unknown } | undefined)?.disposition === 'not_applied') intents.current.delete(key)
      const operationId = intents.current.get(key)
      before.reportError(new Error(operationId
        ? `Restore ${operationId} is unconfirmed. ${presentError(error)} Check the original restore again.`
        : presentError(error)), { kind: 'indeterminate' })
      refresh()
    } finally {
      inFlight.current.delete(key)
    }
  }, [refresh, restoreTarget])

  const source = preview ? sources.get(address(preview.entry)) : undefined
  const readable = preview && (source?.state === 'active' || source?.state === 'retired' && source.history)
  const close = () => setPreview(null)
  useLayoutEffect(() => {
    actionsRef.current = { preview: setPreview, restore,
      getRestore: entry => inFlight.current.has(address(entry)) ? undefined : restoreTarget(entry)?.kind,
      canTakeOver: entry => Boolean(takeoverSource(entry)),
      takeOver: ({ entry, trigger }) => {
        const original = takeoverSource(entry)
        if (original) setTakeover({ source: original, trigger })
      } }
  }, [restore, restoreTarget, takeoverSource])
  return <SavedHistoryContext.Provider value={actionsRef}>
    {children}
    {visible && preview ? preview.conversation && readable ? <AgentSessionReadingSurface source={{ hostId: source!.hostId, agentSessionId: source!.agentSessionId }}
      label={preview.entry.identity?.name || preview.entry.sessionId} returnTrigger={preview.trigger} onClose={close} /> :
      <AgentSessionActionSurface compact title="Quick Look" description={preview.entry.identity?.name || preview.entry.sessionId}
        returnTrigger={preview.trigger} onClose={close}>
        <div className="focus-saved-task__preview-details">
          <p>{preview.detail}</p>
          {readable ? <Button data-focus-saved-conversation type="button" onClick={() => setPreview({ ...preview, conversation: true })}>Open conversation</Button> : null}
        </div>
      </AgentSessionActionSurface> : null}
    {visible && takeover ? <FocusWorkspaceStage><SessionTakeoverSurface active source={takeover.source}
      returnTrigger={takeover.trigger} onClose={() => setTakeover(null)} /></FocusWorkspaceStage> : null}
  </SavedHistoryContext.Provider>
}

export const FocusSavedTaskRow = memo(function FocusSavedTaskRow({ entry, time, displayPath, onRead }: {
  entry: AgentFocusHistoryEntry
  time: ReturnType<typeof createFocusTimeFormatters>
  displayPath: ReturnType<typeof usePathDisplay>
  onRead: ((at: number) => void) | undefined
}) {
  const actions = useContext(SavedHistoryContext)
  const menu = useSpaceObjectMenu()
  const [open, setOpen] = useState(false)
  const identity = entry.identity!
  const name = identity.name || entry.sessionId
  const now = Date.now()
  const dated = Number.isSafeInteger(entry.focusedAt) && entry.focusedAt > 0 && entry.focusedAt <= now
  const shortTime = dated ? time.dateInput(entry.focusedAt).slice(0, 10) === time.dateInput(now).slice(0, 10)
    ? time.ruler(entry.focusedAt) : time.shortDate(entry.focusedAt) : null
  const location = [identity.branch, identity.topicId].filter(Boolean).join(' / ')
  const detail = [`Saved observation · ${entry.sessionId}`, identity.hostId, displayPath(identity.workspacePath, identity.hostId),
    location, dated ? `Last focused · ${time.detailed(entry.focusedAt)}` : 'Focus time not recorded'].filter(Boolean).join('\n')
  const preview = () => ({ entry, trigger: menu.triggerProps.ref.current as HTMLButtonElement | null, detail })
  const quickLook = () => actions?.current?.preview(preview())
  const readTimeline = dated && onRead ? () => onRead(entry.focusedAt) : undefined
  const restore = open ? actions?.current?.getRestore(entry) : undefined
  return <div role="listitem" data-saved-focus-session={entry.sessionId} data-saved-focus-host={identity.hostId}>
    <ContextMenu.Root onOpenChange={value => { setOpen(value); menu.onOpenChange(value) }}>
      <ContextMenu.Trigger asChild {...menu.triggerProps}>
        <button className="focus-saved-task" type="button" title={[name, detail].join('\n')}
          aria-label={`View ${name} saved focus history`} onPointerDown={event => { if (event.button === 0) event.preventDefault() }}
          onClick={readTimeline ?? quickLook}>
          {identity.providerId ? <ResolvedAgentAvatar label={name} providerId={identity.providerId} size={15} /> : <HistoryIcon size={14} aria-hidden="true" />}
          <strong>{name}</strong>
          {shortTime ? <time dateTime={new Date(entry.focusedAt).toISOString()} aria-label={time.detailed(entry.focusedAt)}>{shortTime}</time> : null}
        </button>
      </ContextMenu.Trigger>
      <DocumentOverlayPortal component={ContextMenu.Portal}>
        <ContextMenu.Content className="tab-context-menu" collisionPadding={8} onCloseAutoFocus={menu.onCloseAutoFocus}>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={() => menu.changeIcon(quickLook)}><PreviewIcon size={14} />Quick Look</ContextMenu.Item>
          {readTimeline ? <ContextMenu.Item className="tab-context-menu__item" onSelect={readTimeline}><TimelineIcon size={14} />View in timeline</ContextMenu.Item> : null}
          {restore ? <ContextMenu.Item className="tab-context-menu__item" onSelect={() => { void actions?.current?.restore(entry) }}>
            <ResumeIcon size={14} />{restore === 'open' ? 'Open original Session' : restore === 'check' ? 'Check original restore' : 'Resume from here'}
          </ContextMenu.Item> : null}
          {open && actions?.current?.canTakeOver(entry) ? <ContextMenu.Item className="tab-context-menu__item"
            onSelect={() => menu.changeIcon(() => actions.current?.takeOver(preview()))}>
            <TakeoverIcon size={14} />Take over
          </ContextMenu.Item> : null}
        </ContextMenu.Content>
      </DocumentOverlayPortal>
    </ContextMenu.Root>
  </div>
})
