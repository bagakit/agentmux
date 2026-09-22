import { useEffect, useId, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { useAppStore } from '../store'
import { useServiceNotices, type ServiceNoticeItem } from '../lib/use-service-notices'
import { selectDisplacedAgentNotices, displacedAgentStepOutcome } from '../lib/control-spatial-commit'
import { classifyServiceNotice, serviceNoticeToRender } from '../lib/service-window-notice'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { sessionServiceNotices } from '../lib/session-service-notices'
import { agentLifecycleFailureNotice } from '../lib/agent-lifecycle-feedback'

/** One window-level inbox. Reading a service notice never changes its owner's current facts. */
export function GlobalSystemNotices({ nativeOverlayWarning }: { nativeOverlayWarning?: string | undefined } = {}) {
  const warning = useAppStore((state) => state.environmentWarning)
  const hosts = useAppStore((state) => state.runtimeOwnershipWarnings)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const displacedIds = useAppStore((state) => state.displacedAgentSessionIds)
  const loading = useAppStore((state) => state.loading)
  const selectSession = useAppStore((state) => state.selectSession)
  const queues = useAppStore((state) => state.agentSteerQueues)
  const sending = useAppStore((state) => state.agentSteerInFlight)
  const lifecycleFailure = useAppStore(state => state.errorNoticeContext?.lifecycle)
  const lifecycleMessage = useAppStore(state => state.error ?? state.lastError)
  const workbenchSaveWarning = useAppStore(state => state.workbenchSaveWarning)
  const retryWorkbenchSave = useAppStore(state => state.retryWorkbenchSave)
  const id = useId()
  const [open, setOpen] = useState(false)
  const environment: ServiceNoticeItem[] = warning ? [{ id: 'shell', notice: {
    kind: 'process-degraded', notice: {
      step: 'Local shell environment is incomplete', mode: warning,
      restore: 'Check your shell startup scripts, then restart AgentMux and create a new Agent or terminal. Existing processes keep their original environment.'
    }
  } }] : []
  const ownership: ServiceNoticeItem[] = hosts?.length ? [{ id: 'ownership', notice: {
    kind: 'process-degraded', notice: {
      step: 'Runtime launch record is unavailable',
      mode: `Connected to the compatible Runtime on ${[...hosts].sort().join(', ')}. Existing Agents remain usable; the shared daemon will not be terminated to repair this record.`,
      restore: 'You can continue working. A new launch record will be saved when AgentMux next starts a daemon; restarting the app is not required.'
    }
  } }] : []
  const displaced = selectDisplacedAgentNotices(sessions, tabs, displacedIds).flatMap((item): ServiceNoticeItem[] => {
    const notice = serviceNoticeToRender(classifyServiceNotice(displacedAgentStepOutcome(item.label)))
    return notice ? [{ id: item.agentSessionId, notice,
      action: { label: 'Give it a place', run: () => selectSession(item.agentSessionId) } }] : []
  })
  // Keep each owner's receipts through its unknown startup projection. Displaced IDs are durable;
  // missing Session facts during recovery cannot prove that their placement problem resolved.
  const environmentInbox = useServiceNotices('global:environment', environment, warning !== undefined)
  const ownershipInbox = useServiceNotices('global:runtime-ownership', ownership, hosts !== undefined)
  const displacedKnown = !loading && displacedIds.every((sessionId) => sessions.some((session) => session.id === sessionId))
  const displacedInbox = useServiceNotices('global:displaced-agents', displaced, displacedKnown)
  const sessionNotices: ServiceNoticeItem[] = sessions.flatMap(session => sessionServiceNotices(session, queues[session.id], sending[session.id],
    { message: lifecycleMessage, failure: lifecycleFailure })
    .map(item => ({ ...item, id: JSON.stringify([session.hostId, session.id, item.id]),
      action: { label: `Open ${session.label} Session`, run: () => selectSession(session.id) } })))
  if (lifecycleMessage && lifecycleFailure?.step === 'launch') sessionNotices.push({
    id: JSON.stringify(['launch', lifecycleFailure.regionId]),
    notice: agentLifecycleFailureNotice(lifecycleFailure, lifecycleMessage)
  })
  const sessionInbox = useServiceNotices('global:sessions', sessionNotices, !loading)
  const storage: ServiceNoticeItem[] = workbenchSaveWarning ? [{ id: 'workbench-save', notice: {
    kind: 'indeterminate', notice: {
      step: 'Saving the workbench is unconfirmed',
      mode: 'Your current layout and drafts remain visible. Agent input was not disabled by this save request.',
      restore: `${workbenchSaveWarning} Restore storage access, then retry saving before quitting or updating.`
    }
  }, action: { label: 'Retry saving', run: () => { void retryWorkbenchSave() } } }] : []
  const storageInbox = useServiceNotices('global:workbench-save', storage, true)
  const chromeInbox = useServiceNotices('global:native-chrome', nativeOverlayWarning ? [{
    id: 'floating-chrome', notice: { kind: 'process-degraded', notice: {
      step: 'Native floating content is unavailable', mode: nativeOverlayWarning,
      restore: 'Close and reopen the floating panel. Existing Browser pages and Agents remain available.'
    } }
  }] : [], true)
  const inboxes = [environmentInbox, ownershipInbox, displacedInbox, sessionInbox, storageInbox, chromeInbox]
  const notices = inboxes.flatMap((inbox) => inbox.notices)
  const unread = inboxes.reduce((total, inbox) => total + inbox.unread.length, 0)
  const available = inboxes.every((inbox) => inbox.available)
  const acquireNativeSurfaceOverlay = useAppStore((state) => state.acquireNativeSurfaceOverlay)
  const releaseNativeSurfaceOverlay = useAppStore((state) => state.releaseNativeSurfaceOverlay)
  useEffect(() => {
    if (!open) return
    acquireNativeSurfaceOverlay()
    return () => {
      releaseNativeSurfaceOverlay()
    }
  }, [open, acquireNativeSurfaceOverlay, releaseNativeSurfaceOverlay])
  useEffect(() => {
    if (open) for (const inbox of inboxes) if (inbox.unread.length) inbox.acknowledge(inbox.unread)
  }, [open, environmentInbox, ownershipInbox, displacedInbox, sessionInbox, storageInbox, chromeInbox])
  return <div className="global-system-notices">
    <button type="button" className="global-system-notices__trigger" data-unread={unread > 0}
      aria-label={`System notifications: ${unread} unread, ${notices.length} current`}
      aria-expanded={open} aria-controls={id} title="System notifications"
      popoverTarget={id} popoverTargetAction="toggle">
      <Bell size={14} aria-hidden="true" />
      {notices.length ? <span aria-hidden="true">{notices.length}</span> : null}
      {unread ? <span className="global-system-notices__dot" aria-hidden="true" /> : null}
    </button>
    <div id={id} popover="auto" className="global-system-notices__details" aria-label="System notifications"
      data-state={open ? 'open' : 'closed'}
      onToggle={(event) => setOpen(event.newState === 'open')}>
      <div className="global-system-notices__heading">
        <strong>System notifications</strong>
        <button type="button" className="icon-button" aria-label="Collapse system notifications" title="Collapse system notifications"
          popoverTarget={id} popoverTargetAction="hide"><X size={14} /></button>
      </div>
      {inboxes.map((inbox, index) => <div key={index}>
        {inbox.notices.map((item) => <div key={item.id} className="global-system-notices__item">
          <ServiceWindowNotice notice={item.notice} {...(inbox === storageInbox ? { summary: {
            step: 'Saving the workbench is unconfirmed',
            mode: 'Your window was kept. Agent input was not disabled by this save request.',
            restore: 'Restore storage access, then retry saving before quitting or updating.'
          } } : {})} />
          {item.action ? <button type="button" className="small-button global-system-notices__action" onClick={item.action.run}
            popoverTarget={id} popoverTargetAction="hide">{item.action.label}</button> : null}
        </div>)}
      </div>)}
      {!available ? <p>Waiting for Runtime status.</p> : notices.length === 0 ? <p>No current system notices.</p> : null}
    </div>
  </div>
}
