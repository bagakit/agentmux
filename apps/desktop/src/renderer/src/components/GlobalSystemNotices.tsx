import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { autoUpdate, computePosition, offset, shift, size, type VirtualElement } from '@floating-ui/dom'
import { Bell, X } from 'lucide-react'
import { useAppStore } from '../store'
import { useServiceNotices, type ServiceNoticeItem } from '../lib/use-service-notices'
import { selectDisplacedAgentNotices, displacedAgentStepOutcome } from '../lib/control-spatial-commit'
import { classifyServiceNotice, serviceNoticeToRender } from '../lib/service-window-notice'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { sessionServiceNotices } from '../lib/session-service-notices'
import { agentLifecycleFailureNotice } from '../lib/agent-lifecycle-feedback'
import { errorIdentity } from '@agentmux/client-ui/error-presentation'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { SettingsNavigation } from './SettingsNavigation'
import { runtimeEndpointNotice } from '../lib/runtime-endpoint-notice'

/** One window-level inbox. Reading a service notice never changes its owner's current facts. */
export function GlobalSystemNotices({ nativeOverlayWarning }: { nativeOverlayWarning?: string | undefined } = {}) {
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
  const lifecycleFailure = useAppStore(state => state.errorNoticeContext?.lifecycle)
  const lifecycleMessage = useAppStore(state => state.error ?? state.lastError)
  const workbenchSaveWarning = useAppStore(state => state.workbenchSaveWarning)
  const retryWorkbenchSave = useAppStore(state => state.retryWorkbenchSave)
  const nameSaveUnconfirmed = useAppStore(state => state.nameSaveUnconfirmed)
  const confirmNameSave = useAppStore(state => state.confirmNameSave)
  const nameEditFailure = useAppStore(state => state.nameEditFailure)
  const reviewNameEdit = useAppStore(state => state.reviewNameEdit)
  const desktopNavigationNotice = useAppStore(state => state.desktopNavigationNotice)
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
    { message: lifecycleMessage, failure: lifecycleFailure })
    .filter(item => item.id !== 'connection' || !(endpointWarnings ?? []).some(warning => warning.hostId === session.hostId && warning.availability !== 'connected'))
    .map(item => ({ ...item, id: JSON.stringify([session.hostId, session.id, item.id]),
      action: { label: `Open ${session.label} Session`, run: () => selectSession(session.id) } })))
  if (lifecycleMessage && lifecycleFailure?.step === 'launch') sessionNotices.push({
    id: JSON.stringify(['launch', lifecycleFailure.regionId]),
    cause: JSON.stringify(['launch', errorIdentity(lifecycleMessage)]),
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
  const inboxes = [environmentInbox, ownershipInbox, nameMetadataInbox, endpointInbox, displacedInbox, sessionInbox, storageInbox, chromeInbox, navigationInbox]
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
  }, [open, environmentInbox, ownershipInbox, endpointInbox, displacedInbox, sessionInbox, storageInbox, chromeInbox, navigationInbox])
  return <div className="global-system-notices">
    <button ref={triggerRef} type="button" className="global-system-notices__trigger" data-unread={unread > 0}
      aria-label={`System notifications: ${unread} unread, ${notices.length} current`}
      aria-expanded={open} aria-controls={id} title="System notifications"
      popoverTarget={id} popoverTargetAction="toggle">
      <Bell size={14} aria-hidden="true" />
      {notices.length ? <span aria-hidden="true">{notices.length}</span> : null}
      {unread ? <span className="global-system-notices__dot" aria-hidden="true" /> : null}
    </button>
    <div ref={detailsRef} id={id} popover="auto" className="global-system-notices__details" aria-label="System notifications"
      data-state={open ? 'open' : 'closed'}
      onToggle={(event) => setOpen(event.newState === 'open')}>
      <div className="global-system-notices__heading">
        <strong>System notifications</strong>
        <button type="button" className="icon-button" aria-label="Collapse system notifications" title="Collapse system notifications"
          popoverTarget={id} popoverTargetAction="hide"><X size={14} /></button>
      </div>
      {inboxes.map((inbox, index) => <div key={index}>
        {inbox.notices.map((item) => <div key={item.id} className="global-system-notices__item">
          <ServiceWindowNotice notice={item.notice} {...(item.summary ? { summary: item.summary } : {})} {...(inbox === storageInbox && item.id === 'workbench-save' ? { summary: {
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
