import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { autoUpdate, computePosition, offset, shift, size, type VirtualElement } from '@floating-ui/dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { notificationEventIdentity, projectNotifications, useAppStore } from '../store'
import { useReadReceipts, useServiceNotices, type ServiceNoticeItem } from '../lib/use-service-notices'
import { selectDisplacedAgentNotices, displacedAgentStepOutcome } from '../lib/control-spatial-commit'
import { classifyServiceNotice, serviceNoticeToRender, serviceNoticeAriaLive } from '../lib/service-window-notice'
import { NotificationItem } from './NotificationItem'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { sessionServiceNotices } from '../lib/session-service-notices'
import { runServiceProjection, useRunServiceHealthChanges } from '../lib/run-service-projection'
import { agentLifecycleFailureNotice } from '../lib/agent-lifecycle-feedback'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { SettingsNavigation } from './SettingsNavigation'
import { runtimeEndpointNotice } from '../lib/runtime-endpoint-notice'

const ThemeStatusUnreadIcon = semanticIconComponent('status.unread')
const ThemeObjectNotificationsIcon = semanticIconComponent('object.notifications')
const ThemeLayoutCollapseIcon = semanticIconComponent('layout.collapse')


/** One window-level inbox. Reading a service notice never changes its owner's current facts. */
export function GlobalSystemNotices({ nativeOverlayWarning }: { nativeOverlayWarning?: string | undefined } = {}) {
  useRunServiceHealthChanges()
  const warning = useAppStore((state) => state.environmentWarning)
  const nameMetadataWarning = useAppStore(state => state.sessionNameMetadataWarning)
  const hosts = useAppStore((state) => state.runtimeOwnershipWarnings)
  const endpointWarnings = useAppStore((state) => state.runtimeEndpointWarnings)
  const config = useAppStore((state) => state.config)
  const settings = useContext(SettingsNavigation)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const displacedIds = useAppStore((state) => state.displacedAgentSessionIds)
  const loading = useAppStore((state) => state.loading)
  const selectSession = useAppStore((state) => state.selectSession)
  const queues = useAppStore((state) => state.agentSteerQueues)
  const sending = useAppStore((state) => state.agentSteerInFlight)
  const workbenchSaveWarning = useAppStore(state => state.workbenchSaveWarning)
  const retryWorkbenchSave = useAppStore(state => state.retryWorkbenchSave)
  const nameSaveUnconfirmed = useAppStore(state => state.nameSaveUnconfirmed)
  const confirmNameSave = useAppStore(state => state.confirmNameSave)
  const nameEditFailure = useAppStore(state => state.nameEditFailure)
  const reviewNameEdit = useAppStore(state => state.reviewNameEdit)
  const desktopNavigationNotice = useAppStore(state => state.desktopNavigationNotice)
  const events = useAppStore(state => state.notificationEvents)
  const projection = projectNotifications(events)
  const hasLaunchFailures = projection.current.some(record => record.context?.lifecycle?.step === 'launch')
  const launcherTabs = useMemo(() => new Map(hasLaunchFailures
    ? Object.values(tabs).flatMap(tab => Object.keys(tab.regions).map(regionId => [regionId, tab] as const)) : []), [tabs, hasLaunchFailures])
  const currentError = useAppStore(state => state.error)
  const errorDismissed = useAppStore(state => state.errorDismissed)
  const errorContext = useAppStore(state => state.errorNoticeContext)
  const clearReadEvents = useAppStore(state => state.clearReadNotificationEvents)
  // Window records have no complete startup snapshot. Only reading facts persist across restarts.
  const eventInbox = useReadReceipts('global:events', Object.fromEntries(events.map(event => [event.id, 'read'])), !loading, false)
  const currentErrorInbox = useServiceNotices('global:workflow', currentError && (!errorDismissed || errorContext?.startupSessionSnapshot || errorContext?.startupProviderCatalog) && !errorContext?.lifecycle && !errorContext?.cause &&
    !events.some(event => event.id === notificationEventIdentity(currentError, errorContext)) ? [{ id: 'current', cause: notificationEventIdentity(currentError, errorContext), notice: {
      kind: 'indeterminate', notice: { step: errorContext?.summary ?? 'Operation needs attention',
        mode: currentError, restore: 'Review the original operation before retrying.' }
    } }] : [], !loading)
  const id = useId()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const detailsRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const trigger = triggerRef.current, details = detailsRef.current
    if (!open || !trigger || !details) return
    // Read actual visible input surfaces only while details are open. Their original
    // editor, draft and terminal grid stay in place; the floating inbox moves instead.
    const inputs = [...document.querySelectorAll<HTMLElement>('.agent-input-stack')].filter(desktopElementVisible)
    let disposed = false
    const reference: VirtualElement = { contextElement: trigger, getBoundingClientRect() {
      const anchor = trigger.getBoundingClientRect()
      const top = inputs.filter(desktopElementVisible).reduce((top, input) => Math.min(top, input.getBoundingClientRect().top), anchor.top)
      return new DOMRect(anchor.left, top, anchor.width, 0)
    } }
    const update = async () => {
      const { x, y } = await computePosition(reference, details, {
        strategy: 'fixed', placement: 'top-end', middleware: [offset(8), shift({ padding: 8 }), size({ padding: 8,
          apply({ availableHeight }) {
            if (!disposed) details.style.maxHeight = `${Math.max(0, Math.min(window.innerHeight * .7, availableHeight))}px`
          }
        })]
      })
      if (!disposed) Object.assign(details.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
    }
    const stopPosition = autoUpdate(reference, details, () => { void update() })
    const resize = new ResizeObserver(() => { void update() })
    for (const input of inputs) resize.observe(input)
    return () => {
      disposed = true
      stopPosition(); resize.disconnect()
      for (const property of ['left', 'top', 'max-height', 'visibility']) details.style.removeProperty(property)
    }
  }, [open])
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
  const nameMetadataInbox = useServiceNotices('global:session-names', nameMetadataWarning ? [{
    id: 'metadata', cause: nameMetadataWarning.code, notice: {kind: 'indeterminate', notice: {
      step: 'Reading saved Session names', mode: nameMetadataWarning.message, restore: nameMetadataWarning.recovery
    }}
  }] : [], !loading)
  const endpoints: ServiceNoticeItem[] = (endpointWarnings ?? []).map((warning) => runtimeEndpointNotice(warning,
    config?.hosts.find((host) => host.id === warning.hostId)?.label ?? warning.hostId,
    hostId => settings?.openHost(hostId)))
  const endpointInbox = useServiceNotices('global:runtime-endpoints', endpoints, endpointWarnings !== undefined)
  const displacedKnown = !loading && displacedIds.every((sessionId) => sessions.some((session) => session.id === sessionId))
  const displacedInbox = useServiceNotices('global:displaced-agents', displaced, displacedKnown)
  const sessionNotices: ServiceNoticeItem[] = sessions.flatMap(session => sessionServiceNotices(session, queues[session.id], sending[session.id],
    runServiceProjection.read(session),
    !(endpointWarnings ?? []).some(warning => warning.hostId === session.control.hostId &&
      warning.observationOrigin !== undefined))
    .filter(item => item.id !== 'connection' || !(endpointWarnings ?? []).some(warning => warning.scope !== 'observation' && warning.hostId === session.hostId && warning.availability !== 'connected'))
    .map(item => ({ ...item, id: JSON.stringify([session.hostId, session.id, item.id]),
      action: { label: `Open ${session.label} Session`, run: () => selectSession(session.id) } })))
  const sessionInbox = useServiceNotices('global:sessions', sessionNotices, !loading)
  const storage: ServiceNoticeItem[] = workbenchSaveWarning ? [{ id: 'workbench-save', notice: {
    kind: 'indeterminate', notice: {
      step: 'Saving the workbench is unconfirmed',
      mode: 'Your current layout and drafts remain visible. Agent input was not disabled by this save request.',
      restore: `${workbenchSaveWarning} Restore storage access, then retry saving before quitting or updating.`
    }
  }, action: { label: 'Retry saving', run: () => { void retryWorkbenchSave() } } }] : []
  if (nameSaveUnconfirmed) storage.push({ id: `name-save:${nameSaveUnconfirmed.operationId}`, notice: {
    kind: 'indeterminate', notice: { step: 'Name applied · disk confirmation unknown',
      mode: 'The applied name and your running Agent remain available.',
      restore: nameSaveUnconfirmed.message }
  }, action: { label: 'Confirm saved name', run: () => { void confirmNameSave() } } })
  if (nameEditFailure) storage.push({ id: `name-edit:${nameEditFailure.operationId}`, notice: {
    kind: 'indeterminate', notice: { step: 'Name edit has no confirmed result',
      mode: 'The current name and your running Agent remain available.',
      restore: nameEditFailure.message }
  }, action: { label: 'Review current name', run: () => { void reviewNameEdit() } } })
  const storageInbox = useServiceNotices('global:workbench-save', storage, true)
  const navigationInbox = useServiceNotices('global:desktop-navigation', desktopNavigationNotice ? [{
    id: 'desktop-navigation', notice: { kind: 'indeterminate', notice: {
      step: desktopNavigationNotice.step, mode: desktopNavigationNotice.message, restore: desktopNavigationNotice.recovery
    } }
  }] : [], true)
  const chromeInbox = useServiceNotices('global:native-chrome', nativeOverlayWarning ? [{
    id: 'floating-chrome', notice: { kind: 'process-degraded', notice: {
      step: 'Native floating content is unavailable', mode: nativeOverlayWarning,
      restore: 'Close and reopen the floating panel. Existing Browser pages and Agents remain available.'
    } }
  }] : [], true)
  const inboxes = [environmentInbox, ownershipInbox, nameMetadataInbox, endpointInbox, displacedInbox, sessionInbox, storageInbox, chromeInbox, navigationInbox, currentErrorInbox]
  const notices = inboxes.flatMap((inbox) => inbox.notices)
  const currentCount = notices.length + projection.current.length
  const unread = inboxes.reduce((total, inbox) => total + inbox.unread.length, eventInbox.unread.length)
  const count = notices.length + events.length
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
    if (!open) return
    for (const inbox of inboxes) if (inbox.unread.length) inbox.acknowledge(inbox.unread)
    if (eventInbox.unread.length) eventInbox.acknowledge(eventInbox.unread)
  }, [open, environmentInbox, ownershipInbox, nameMetadataInbox, endpointInbox, displacedInbox, sessionInbox, storageInbox, chromeInbox, navigationInbox, currentErrorInbox, eventInbox])
  const recentEvents = [...projection.history].reverse()
  const sessionsByIdentity = new Map(sessions.map(session => [JSON.stringify([session.hostId, session.id]), session]))
  const unreadEventIds = new Set(eventInbox.unread)
  const readEvents = projection.history.filter(event => !unreadEventIds.has(event.id)).length
  const latestUnreadEvent = [...events].reverse().find(event => unreadEventIds.has(event.id))
  const liveVolume = serviceNoticeAriaLive(latestUnreadEvent?.context?.kind ?? 'indeterminate')
  function navigationAction(action: NonNullable<ServiceNoticeItem['action']>) {
    return { label: action.label, run() { action.run(); detailsRef.current?.hidePopover?.() } }
  }
  return <div className="global-system-notices">
    <span className="global-system-notices__announcement" role={liveVolume === 'assertive' ? 'alert' : 'status'} aria-live={liveVolume}>
      {latestUnreadEvent ? `${latestUnreadEvent.context?.summary ?? Array.from(latestUnreadEvent.message.replace(/\s+/g, ' ')).slice(0, 100).join('')}. Review system notifications for details.` : ''}
    </span>
    <button ref={triggerRef} type="button" className="global-system-notices__trigger" data-unread={unread > 0}
      aria-label={`System notifications: ${unread} unread, ${currentCount} current, ${projection.history.length} recent events`}
      aria-expanded={open} aria-controls={id} title="System notifications"
      popoverTarget={id} popoverTargetAction="toggle">
      <ThemeObjectNotificationsIcon size={14} aria-hidden="true" />
      {unread ? <span aria-hidden="true">{unread}</span> : null}
      {unread ? <ThemeStatusUnreadIcon size={5} className="global-system-notices__dot" aria-hidden="true" /> : null}
    </button>
    <div ref={detailsRef} id={id} popover="auto" className="global-system-notices__details" aria-label="System notifications"
      data-state={open ? 'open' : 'closed'}
      onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.newState === 'open') }}>
      <div className="global-system-notices__heading">
        <strong>System notifications</strong>
        <button type="button" className="icon-button" aria-label="Collapse system notifications" title="Collapse system notifications"
          popoverTarget={id} popoverTargetAction="hide"><ThemeLayoutCollapseIcon size={14} /></button>
      </div>
      {currentCount ? <h3 className="global-system-notices__section">Current issues <span>{currentCount}</span></h3> : null}
      {inboxes.map((inbox, index) => <div key={index}>
        {inbox.notices.map((item) => <NotificationItem key={item.id} noticeId={item.id} kind={item.notice.kind}
          title={item.summary?.step ?? item.notice.notice.step}
          detail={[item.notice.notice.step, item.notice.notice.mode, item.notice.notice.restore].join('\n')}
          {...(item.action ? { action: navigationAction(item.action) } : {})}>
          <ServiceWindowNotice notice={item.notice} />
        </NotificationItem>)}
      </div>)}
      {projection.current.map(record => {
        const lifecycle = record.context?.lifecycle
        const notice = lifecycle ? agentLifecycleFailureNotice(lifecycle, record.message) : {
          kind: 'indeterminate' as const, notice: {
            step: record.context?.summary ?? 'Operation needs attention', mode: record.message,
            restore: 'Review the original operation before retrying.'
          }
        }
        const subject = lifecycle?.step === 'resume' ? lifecycle.subject : record.context?.subject
        const session = subject?.kind === 'agent' ? sessionsByIdentity.get(JSON.stringify([subject.hostId, subject.agentSessionId])) : undefined
        const launcher = lifecycle?.step === 'launch' ? launcherTabs.get(lifecycle.regionId) : undefined
        const location = lifecycle?.step === 'launch'
          ? `Region ${lifecycle.regionId} · ${launcher?.name ?? (launcher ? 'New Tab' : 'Original location unavailable')}` : undefined
        const source = lifecycle?.step === 'launch'
          ? `${location} · ${launcher ? 'Tab' : 'Reported Tab'} ${launcher?.id ?? lifecycle.tabId}`
          : subject?.kind === 'agent' ? `Host ${subject.hostId} · Session ${subject.agentSessionId} · Run ${subject.run.runId}` : undefined
        return <NotificationItem key={record.id} noticeId={record.id} kind={notice.kind}
          title={location ? `${location} · ${notice.notice.step}` : notice.notice.step}
          detail={[source, notice.notice.step, notice.notice.mode, notice.notice.restore].filter(Boolean).join('\n')}
          {...(session ? { action: navigationAction({ label: `Open ${session.label}`, run: () => { void selectSession(session.id) } }) } : {})}>
          {source ? <p>{source}</p> : null}
          <ServiceWindowNotice notice={notice} />
        </NotificationItem>
      })}
      {projection.history.length ? <div className="global-system-notices__section">
        <h3>Recent events <span>{projection.history.length}</span></h3>
        {readEvents ? <button type="button" className="small-button" onClick={clearReadEvents}>Clear read events</button> : null}
      </div> : null}
      {recentEvents.map(event => {
        const subject = event.context?.subject
        const session = subject?.kind === 'agent' ? sessionsByIdentity.get(JSON.stringify([subject.hostId, subject.agentSessionId])) : undefined
        return <NotificationItem key={event.id} eventId={event.id} kind={event.context?.kind ?? 'indeterminate'}
          title={event.context?.summary ?? (event.context?.kind === 'agent-broken' ? `${session?.label ?? 'Agent'} stopped unexpectedly` : event.message)}
          detail={event.message}
          {...(session ? { action: navigationAction({ label: `Open ${session.label}`, run: () => { void selectSession(session.id) } }) } : {})} />
      })}
      {!available ? <p>Waiting for Runtime status.</p> : count === 0 ? <p>No system notifications.</p> : null}
    </div>
  </div>
}
