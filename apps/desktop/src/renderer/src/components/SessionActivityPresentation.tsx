import { useSessionLinkOpening } from '../lib/session-link-opening'
import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { cloneElement, useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode, type ReactElement } from 'react'
import { useAppStore } from '../store'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../lib/workbench-presentation'
import { createSessionProjectFileContextSelector } from '../lib/session-project-file-context'
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
  activity, eligible, recovery, readOnly, resourceOrigin, composer, onAnnotate, renderFrame, selectRegion }: {
  target: WorkbenchViewTarget
  regionId: string
  sourceKey: string
  sessionId: string
  name: string
  executorLabel: string
  executionHost: RegionExecutionHost
  activity?: ComponentProps<typeof ActivityView>
  eligible: boolean
  recovery?: ReactNode
  readOnly: boolean
  resourceOrigin: OpenHttpLinkOrigin
  composer?: ReactNode
  onAnnotate?: ((annotation: ConversationAnnotation) => void) | undefined
  renderFrame: (content: ReactNode, target: WorkbenchViewTarget) => ReactNode
  selectRegion: () => void
}) {
  const reference = target.reference!
  const visible = target.visible !== false
  const origin = useMemo(() => ({ ...resourceOrigin, sessionId, workspaceId: reference.displayWorkspaceId, tabGroupId: reference.groupId,
    tabId: reference.tabId, regionId }), [sessionId, resourceOrigin.workspaceId,
      reference.displayWorkspaceId, reference.groupId, reference.tabId, regionId])
  // Parsing belongs to the original Session resource; placement belongs to this proven display.
  const selectFileContext = useMemo(() => createSessionProjectFileContextSelector(sessionId,
    { ...origin, workspaceId: reference.displayWorkspaceId }),
  [sessionId, origin, reference.displayWorkspaceId])
  const fileContext = useAppStore(selectFileContext)
  const [service, setService] = useState<string | null>(null)
  const linkOpening = useSessionLinkOpening(origin, setService, selectRegion)
  const openProjectFile = linkOpening.activateFile
  const linkRequest = linkOpening.request
  const openProseLink = linkOpening.activateHttp
  const chooseDestination = linkOpening.choose
  const surfaceRef = useRef<HTMLElement>(null)
  const noteRef = useRef<ConversationAnnotationNoteHandle>(null)
  const selectAnnotation = useCallback((selection: ConversationAnnotationSelection) => {
    selectRegion()
    noteRef.current?.select(selection, sessionId)
  }, [selectRegion, sessionId])
  const presented = useRef<{ sourceKey: string; content: ReactElement<ComponentProps<typeof ActivityView>> | null }>({ sourceKey, content: null })
  if (presented.current.sourceKey !== sourceKey) presented.current = { sourceKey, content: null }
  if (visible && eligible && activity) {
    const { openWorkspaceFile: _primaryFile, onSelectAnnotation: _primaryAnnotation, ...facts } = activity
    presented.current.content = <ActivityView {...facts}
      workspaceRoot={fileContext.workspaceRoot} homeDir={fileContext.homeDir}
      fileReferenceNotice={fileContext.issue ? <div role="status" className="activity-feed__read-notice">{fileContext.issue}</div> : undefined}
      {...(fileContext.kind !== 'unconfirmed' && fileContext.kind !== 'unassigned' ? { openWorkspaceFile: openProjectFile } : {})}
      openHttpLink={openProseLink}
      {...(onAnnotate ? { onSelectAnnotation: selectAnnotation } : {})}
      {...(activity.conversationReading ? { conversationReading: { ...activity.conversationReading, enabled: visible && eligible, opened: false, onClose: undefined } } : {})} />
  }
  const reading = activity?.conversationReading ?? presented.current.content?.props.conversationReading
  const content = presented.current.content && reading
    ? cloneElement(presented.current.content, { conversationReading: { ...reading,
      enabled: visible && eligible, opened: false, onClose: undefined } }) : presented.current.content
  const hostId = workbenchSessionStageHostId(target, regionId)
  return <StableWorkbenchView kind="region" homeId={`${hostId}:parked`} targetId={hostId}
    active={target.active} visible={visible} retainedRegionId={regionId} reference={{ ...reference, regionId }}
    onSelectRegion={() => selectRegion()}>
    {renderFrame(<SessionRegionHost arrangement="columns" className="workbench-session-region-host">
      <section ref={surfaceRef} className="agent-surface" data-agent-surface-mode="activity"
        data-session-presentation={hostId} aria-hidden={!visible} inert={!visible}>
        <AgentRegionHeader name={name} executorLabel={executorLabel} sessionId={sessionId} sessionKind="agent" executionHost={executionHost}
          regionId={regionId} readOnly={readOnly} onHistory={undefined} {...(target.headerPortalTargetId ? { portalTargetId: target.headerPortalTargetId } : {})} />
        <div className="agent-body" data-observation-surface="workflow">
          {!eligible ? recovery ?? <div role="status" className="workbench-restore-notice">Activity is retained here. Live Terminal and recovery remain in the original Session work surface.</div> : null}
          {service && eligible ? <div role="status" className="activity-feed__read-notice">{service}</div> : null}
          <div className="agent-terminal-stage" hidden={!eligible} inert={!eligible}>{content}</div>
        </div>
        <OpenDestinationPopover request={linkRequest} canSplit={linkOpening.canSplit}
          onDismiss={linkOpening.dismiss} onSelect={chooseDestination} />
        <ConversationAnnotationNote ref={noteRef} sessionId={sessionId} regionRef={surfaceRef}
          active={visible && eligible && Boolean(onAnnotate)} {...(onAnnotate ? { onAnnotate } : {})} />
        {composer ? <div className="agent-input-stack" data-input-surface="activity" hidden={!eligible} inert={!eligible}>{composer}</div> : null}
      </section>
    </SessionRegionHost>, target)}
  </StableWorkbenchView>
}
