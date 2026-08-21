import { useEffect, useId, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { useAppStore } from '../store'
import { useServiceNotices, type ServiceNoticeItem } from '../lib/use-service-notices'
import { selectDisplacedAgentNotices, displacedAgentStepOutcome } from '../lib/control-spatial-commit'
import { classifyServiceNotice, serviceNoticeToRender } from '../lib/service-window-notice'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** One window-level inbox. Reading a service notice never changes its owner's current facts. */
export function GlobalSystemNotices() {
  const warning = useAppStore((state) => state.environmentWarning)
  const hosts = useAppStore((state) => state.runtimeOwnershipWarnings)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const displacedIds = useAppStore((state) => state.displacedAgentSessionIds)
  const loading = useAppStore((state) => state.loading)
  const selectSession = useAppStore((state) => state.selectSession)
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
  const inboxes = [environmentInbox, ownershipInbox, displacedInbox]
  const notices = inboxes.flatMap((inbox) => inbox.notices)
  const unread = inboxes.reduce((total, inbox) => total + inbox.unread.length, 0)
  const available = inboxes.every((inbox) => inbox.available)
  useEffect(() => {
    if (open) for (const inbox of inboxes) if (inbox.unread.length) inbox.acknowledge(inbox.unread)
  }, [open, environmentInbox, ownershipInbox, displacedInbox])
  return <div className="global-system-notices">
    <button type="button" className="global-system-notices__trigger" data-unread={unread > 0}
      aria-label={`System notifications: ${unread} unread, ${notices.length} current`}
      aria-expanded={open} aria-controls={id} title="System notifications"
      popoverTarget={id} popoverTargetAction="toggle">
      <Bell size={13} aria-hidden="true" />System
      {notices.length ? <span aria-hidden="true">{notices.length}</span> : null}
      {unread ? <span className="global-system-notices__dot" aria-hidden="true" /> : null}
    </button>
    <div id={id} popover="auto" className="global-system-notices__details" aria-label="System notifications"
      onToggle={(event) => setOpen(event.newState === 'open')}>
      <div className="global-system-notices__heading">
        <strong>System notifications</strong>
        <button type="button" className="icon-button" aria-label="Collapse system notifications" title="Collapse system notifications"
          popoverTarget={id} popoverTargetAction="hide"><X size={14} /></button>
      </div>
      {inboxes.map((inbox, index) => <div key={index}>
        {inbox.notices.map((item) => <div key={item.id} className="global-system-notices__item">
          <ServiceWindowNotice notice={item.notice} />
          {item.action ? <button type="button" className="small-button global-system-notices__action" onClick={item.action.run}>{item.action.label}</button> : null}
        </div>)}
      </div>)}
      {!available ? <p>Waiting for Runtime status.</p> : notices.length === 0 ? <p>No current system notices.</p> : null}
    </div>
  </div>
}
