import { usePendingDeliveryLayout, type PendingDeliveryLayout } from '../lib/pending-delivery-layout'
import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode, type ReactElement } from 'react'
import { retainActivityControls } from '../lib/retained-activity'
import { useAppStore, currentCoreSpatialGraph } from '../store'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../lib/workbench-presentation'
import { createSessionProjectFileContextSelector } from '../lib/session-project-file-context'
import { useSessionLinkOpening } from '../lib/session-link-opening'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { ActivityView } from './ActivityView'
import { AgentRegionHeader } from './AgentRegionHeader'
import type { RegionExecutionHost } from '../lib/region-execution-host'
import { StableWorkbenchView } from './StableWorkbenchView'
import { SessionRegionHost } from './SessionRegionHost'
import { OpenDestinationPopover } from './OpenDestinationBar'
import type { ConversationAnnotation } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationAnnotationNote, type ConversationAnnotationNoteHandle } from './ConversationAnnotationNote'

/** A reading/input presentation, not a Session, Reader, Terminal or lifecycle owner. */
export function SessionActivityPresentation({ target, regionId, sourceKey, sessionId, name, executorLabel, executionHost,
  activity, eligible, recovery, readOnly, resourceOrigin, renderComposer, onAnnotate, renderFrame, selectRegion, header, takeoverSurface, historyOpen = false, onCloseHistory, historyReturnTrigger, historyReturnLabel }: {
  target: WorkbenchViewTarget
  regionId: string
  sourceKey: string
  sessionId: string
  name: string
  executorLabel: string
  executionHost: RegionExecutionHost
  /** SessionPane supplies its original controls, bound to this exact display. */
  header?: ReactNode
  takeoverSurface?: ReactNode
  historyOpen?: boolean
  onCloseHistory?: () => void
  historyReturnTrigger?: HTMLButtonElement | null | undefined
  historyReturnLabel?: string
  activity?: ComponentProps<typeof ActivityView>
  eligible: boolean
  recovery?: ReactNode
  readOnly: boolean
  resourceOrigin: OpenHttpLinkOrigin
  renderComposer?: (layout: PendingDeliveryLayout) => ReactNode
  onAnnotate?: ((annotation: ConversationAnnotation) => void) | undefined
  renderFrame: (content: ReactElement<ComponentProps<typeof ActivityView>> | null, target: WorkbenchViewTarget) => ReactNode
  selectRegion: () => void
}) {
  const reference = target.reference!
  const visible = target.visible !== false
  const origin = useMemo(() => ({ ...resourceOrigin, workspaceId: reference.displayWorkspaceId, tabGroupId: reference.groupId,
    tabId: reference.tabId, regionId }), [resourceOrigin.workspaceId, resourceOrigin.sessionId,
      reference.displayWorkspaceId, reference.groupId, reference.tabId, regionId])
  // Parsing belongs to the original Session resource; placement belongs to this proven display.
  const selectFileContext = useMemo(() => createSessionProjectFileContextSelector(sessionId,
    { ...origin, workspaceId: reference.displayWorkspaceId }, currentCoreSpatialGraph),
  [sessionId, origin, reference.displayWorkspaceId])
  const fileContext = useAppStore(selectFileContext)
  const [service, setService] = useState<string | null>(null)
  const fileOpening = useSessionLinkOpening(origin, setService, selectRegion, target)
  const openProjectFile = fileOpening.activateFile
  const openProseLink = fileOpening.activateHttp
  const surfaceRef = useRef<HTMLElement>(null)
  const pendingLayout = usePendingDeliveryLayout({ boundaryRef: surfaceRef, active: visible && eligible })
  const noteRef = useRef<ConversationAnnotationNoteHandle>(null)
  const historyActions = useRef({ onCloseHistory, selectRegion })
  historyActions.current = { onCloseHistory, selectRegion }
  const closeHistory = useCallback(() => {
    const document = surfaceRef.current?.ownerDocument
    const closingFocus = document?.activeElement
    historyActions.current.onCloseHistory?.()
    historyActions.current.selectRegion()
    document?.defaultView?.requestAnimationFrame(() => {
      const active = document.activeElement
      if (visible && historyReturnTrigger?.isConnected && !historyReturnTrigger.disabled &&
        !historyReturnTrigger.closest('[hidden], [inert], [aria-hidden="true"]') &&
        (!active || active === document.body || active === closingFocus)) historyReturnTrigger.focus()
    })
  }, [visible, historyReturnTrigger])
  const selectAnnotation = useCallback((selection: ConversationAnnotationSelection) => {
    selectRegion()
    noteRef.current?.select(selection, sessionId)
  }, [selectRegion, sessionId])
  const presented = useRef<{ sourceKey: string; content: ReactElement<ComponentProps<typeof ActivityView>> | null }>({ sourceKey, content: null })
  if (presented.current.sourceKey !== sourceKey) presented.current = { sourceKey, content: null }
  const revealPending = Boolean(activity?.revealRequest)
  if (visible && (eligible || revealPending) && activity) {
    const { openWorkspaceFile: _primaryFile, onSelectAnnotation: _primaryAnnotation, ...facts } = activity
    presented.current.content = <ActivityView {...facts}
      workspaceRoot={fileContext.workspaceRoot} homeDir={fileContext.homeDir}
      fileReferenceNotice={fileContext.issue ? <div role="status" className="activity-feed__read-notice">{fileContext.issue}</div> : undefined}
      {...(fileContext.kind !== 'unconfirmed' && fileContext.kind !== 'unassigned' ? { openWorkspaceFile: openProjectFile } : {})}
      openHttpLink={openProseLink}
      {...(onAnnotate ? { onSelectAnnotation: selectAnnotation } : {})}
      {...(activity.conversationReading ? { conversationReading: { ...activity.conversationReading, enabled: visible && (eligible || revealPending), opened: historyOpen, onClose: historyOpen ? closeHistory : undefined, ...(historyReturnLabel ? { returnLabel: historyReturnLabel } : {}),
        consumer: { ...activity.conversationReading.consumer, regionId, presentationId: workbenchSessionStageHostId(target, regionId),
          visible, activityShown: eligible, viewMode: 'activity' } } } : {})} />
  }
  const reading = activity?.conversationReading ?? presented.current.content?.props.conversationReading
  if (presented.current.content) presented.current.content = retainActivityControls(presented.current.content, {
    activitySemantic: activity?.activitySemantic ?? 'unknown', revealRequest: activity?.revealRequest ?? null,
    ...(reading ? { conversationReading: { ...reading, enabled: visible && (eligible || revealPending), opened: historyOpen, onClose: historyOpen ? closeHistory : undefined, ...(historyReturnLabel ? { returnLabel: historyReturnLabel } : {}),
      consumer: { ...reading.consumer, regionId, presentationId: workbenchSessionStageHostId(target, regionId),
        visible, activityShown: eligible, viewMode: 'activity' } } } : {})
  })
  const content = presented.current.content
  const hostId = workbenchSessionStageHostId(target, regionId)
  return <StableWorkbenchView kind="region" homeId={`${hostId}:parked`} targetId={hostId}
    active={target.active} visible={visible} retainedRegionId={regionId} reference={{ ...reference, regionId }}
    onSelectRegion={() => selectRegion()}>
    {renderFrame(<SessionRegionHost arrangement="columns" className="workbench-session-region-host">
      <section ref={surfaceRef} className="agent-surface" data-agent-surface-mode="activity"
        data-session-presentation={hostId} aria-hidden={!visible} inert={!visible}>
        {header ?? <AgentRegionHeader name={name} executorLabel={executorLabel} sessionId={sessionId} sessionKind="agent" executionHost={executionHost}
          regionId={regionId} readOnly={readOnly} onHistory={undefined} {...(target.headerPortalTargetId ? { portalTargetId: target.headerPortalTargetId } : {})} />}
        {takeoverSurface}
        <div className="agent-body" data-observation-surface="workflow">
          {!eligible ? recovery ?? <div role="status" className="workbench-restore-notice">Activity is retained here. Live Terminal and recovery remain in the original Session work surface.</div> : null}
          {service && eligible ? <div role="status" className="activity-feed__read-notice">{service}</div> : null}
          <div className="agent-terminal-stage" hidden={!eligible} inert={!eligible}>{content}</div>
        </div>
        <OpenDestinationPopover request={fileOpening.request} canSplit={fileOpening.canSplit}
          onDismiss={fileOpening.dismiss} onSelect={fileOpening.choose} />
        <ConversationAnnotationNote ref={noteRef} sessionId={sessionId} regionRef={surfaceRef}
          origin={origin}
          active={visible && eligible && Boolean(onAnnotate)} {...(onAnnotate ? { onAnnotate } : {})} />
        {renderComposer ? <div className="agent-input-stack" data-input-surface="activity" hidden={!eligible} inert={!eligible}>{renderComposer(pendingLayout)}</div> : null}
      </section>
    </SessionRegionHost>, target)}
  </StableWorkbenchView>
}
