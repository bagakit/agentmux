import { useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../lib/workbench-presentation'
import { createSessionProjectFileContextSelector } from '../lib/session-project-file-context'
import { dismissOpenDestinationRequest, type OpenDestination, type OpenHttpLinkOrigin } from '../lib/open-destination'
import { terminalLinkModifierOpensSystemBrowser } from '../lib/terminal-link-gesture'
import { isMacPlatform } from '../lib/host-platform'
import { ActivityView } from './ActivityView'
import { AgentRegionHeader } from './AgentRegionHeader'
import { StableWorkbenchView } from './StableWorkbenchView'
import { SessionRegionHost } from './SessionRegionHost'
import { OpenDestinationPopover, type OpenDestinationRequest } from './OpenDestinationBar'
import type { LinkClickModifiers } from './AgentMarkdown'
import type { ConversationAnnotation } from './ConversationMessage'
import { ConversationAnnotationNote, type ConversationAnnotationNoteHandle, type ConversationAnnotationSelection } from './ConversationAnnotationNote'

/** A reading/input presentation, not a Session, Reader, Terminal or lifecycle owner. */
export function SessionActivityPresentation({ target, regionId, sourceKey, sessionId, name, executorLabel,
  activity, eligible, readOnly, resourceOrigin, composer, onAnnotate, renderFrame, selectRegion }: {
  target: WorkbenchViewTarget
  regionId: string
  sourceKey: string
  sessionId: string
  name: string
  executorLabel: string
  activity: ComponentProps<typeof ActivityView>
  eligible: boolean
  readOnly: boolean
  resourceOrigin: OpenHttpLinkOrigin
  composer?: ReactNode
  onAnnotate?: ((annotation: ConversationAnnotation) => void) | undefined
  renderFrame: (content: ReactNode, target: WorkbenchViewTarget) => ReactNode
  selectRegion: () => void
}) {
  const reference = target.reference!
  const visible = target.visible !== false
  const origin = useMemo(() => ({ ...resourceOrigin, workspaceId: reference.displayWorkspaceId, tabGroupId: reference.groupId,
    tabId: reference.tabId, regionId }), [resourceOrigin.workspaceId, resourceOrigin.sessionId,
      reference.displayWorkspaceId, reference.groupId, reference.tabId, regionId])
  // Parsing belongs to the original Session resource; placement belongs to this proven display.
  const selectFileContext = useMemo(() => createSessionProjectFileContextSelector(sessionId,
    { ...origin, workspaceId: reference.displayWorkspaceId }),
  [sessionId, origin, reference.displayWorkspaceId])
  const fileContext = useAppStore(selectFileContext)
  const openFile = useAppStore(state => state.openFile)
  const openHttpLink = useAppStore(state => state.openHttpLink)
  const reportError = useAppStore(state => state.reportError)
  const [service, setService] = useState<string | null>(null)
  const openProjectFile = useCallback((path: string, location?: { line: number; column?: number }) => {
    selectRegion()
    if (selectFileContext(useAppStore.getState()) !== fileContext || fileContext.kind === 'unconfirmed') {
      setService('The rendered file resource or display occurrence changed. The Agent keeps running.')
      return
    }
    void openFile(path, reference.groupId, location,
      fileContext.project?.workspaceId ?? resourceOrigin.workspaceId, undefined,
      fileContext.placement ? { ...fileContext.placement, displayWorkspaceId: reference.displayWorkspaceId } : undefined)
      .then(opened => { if (!opened) setService('The file resource or this display occurrence could not be confirmed.') })
      .catch(reportError)
  }, [selectRegion, selectFileContext, fileContext, openFile, reference.groupId,
    reference.displayWorkspaceId, resourceOrigin.workspaceId, reportError])
  const [linkRequest, setLinkRequest] = useState<OpenDestinationRequest | null>(null)
  const nextRequest = useRef(0)
  const openProseLink = useCallback((url: string, event: LinkClickModifiers) => {
    selectRegion()
    if (terminalLinkModifierOpensSystemBrowser(event, isMacPlatform())) {
      void openHttpLink(origin, url, 'system').catch(reportError)
    } else setLinkRequest({ id: ++nextRequest.current, url, x: event.clientX, y: event.clientY })
  }, [selectRegion, openHttpLink, origin, reportError])
  const chooseDestination = useCallback((destination: OpenDestination) => {
    if (!linkRequest) return
    const request = linkRequest
    setLinkRequest(current => dismissOpenDestinationRequest(current, request.id))
    selectRegion()
    void openHttpLink(origin, request.url, destination).catch(reportError)
  }, [linkRequest, selectRegion, openHttpLink, origin, reportError])
  const surfaceRef = useRef<HTMLElement>(null)
  const noteRef = useRef<ConversationAnnotationNoteHandle>(null)
  const selectAnnotation = useCallback((selection: ConversationAnnotationSelection) => {
    selectRegion()
    noteRef.current?.select(selection, sessionId)
  }, [selectRegion, sessionId])
  const presented = useRef<{ sourceKey: string; content: ReactNode }>({ sourceKey, content: null })
  if (presented.current.sourceKey !== sourceKey) presented.current = { sourceKey, content: null }
  if (visible && eligible) {
    const { openWorkspaceFile: _primaryFile, onSelectAnnotation: _primaryAnnotation, ...facts } = activity
    presented.current.content = <ActivityView {...facts}
      workspaceRoot={fileContext.workspaceRoot} homeDir={fileContext.homeDir}
      fileReferenceNotice={fileContext.issue ? <div role="status" className="activity-feed__read-notice">{fileContext.issue}</div> : undefined}
      {...(fileContext.kind !== 'unconfirmed' && fileContext.kind !== 'unassigned' ? { openWorkspaceFile: openProjectFile } : {})}
      openHttpLink={openProseLink}
      {...(onAnnotate ? { onSelectAnnotation: selectAnnotation } : {})}
      {...(activity.userMessageRead ? { userMessageRead: { ...activity.userMessageRead, onReadEarlier: () =>
        setService('Earlier records are available in History in the original Session work surface. This presentation keeps Activity and your draft.') } } : {})} />
  }
  const hostId = workbenchSessionStageHostId(target, regionId)
  return <StableWorkbenchView kind="region" homeId={`${hostId}:parked`} targetId={hostId}
    active={target.active} retainedRegionId={regionId} reference={{ ...reference, regionId }}
    onSelectRegion={() => selectRegion()}>
    {renderFrame(<SessionRegionHost arrangement="columns" className="workbench-session-region-host">
      <section ref={surfaceRef} className="agent-surface" data-agent-surface-mode="activity"
        data-session-presentation={hostId} aria-hidden={!visible} inert={!visible}>
        <AgentRegionHeader name={name} executorLabel={executorLabel} sessionId={sessionId}
          regionId={regionId} readOnly={readOnly} onHistory={undefined} {...(target.headerPortalTargetId ? { portalTargetId: target.headerPortalTargetId } : {})} />
        <div className="agent-body" data-observation-surface="workflow">
          {!eligible ? <div role="status" className="workbench-restore-notice">Activity is retained here. Live Terminal and recovery remain in the original Session work surface.</div> : null}
          {service && eligible ? <div role="status" className="activity-feed__read-notice">{service}</div> : null}
          <div className="agent-terminal-stage" hidden={!eligible} inert={!eligible}>{presented.current.content}</div>
        </div>
        <OpenDestinationPopover request={linkRequest} canSplit={Boolean(origin.tabId && origin.regionId)}
          onDismiss={id => setLinkRequest(current => dismissOpenDestinationRequest(current, id))} onSelect={chooseDestination} />
        <ConversationAnnotationNote ref={noteRef} sessionId={sessionId} regionRef={surfaceRef}
          active={visible && eligible && Boolean(onAnnotate)} {...(onAnnotate ? { onAnnotate } : {})} />
        {composer ? <div className="agent-input-stack" data-input-surface="activity" hidden={!eligible} inert={!eligible}>{composer}</div> : null}
      </section>
    </SessionRegionHost>, target)}
  </StableWorkbenchView>
}
