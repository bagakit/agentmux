import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { getModalOverlayContainer, ModalAttachmentDismissal } from '@agentmux/client-ui/components/Modal'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { autoUpdate, computePosition, offset, shift, size } from '@floating-ui/dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { notificationEventIdentity, projectNotifications, useAppStore, type NotificationEvent, type NotificationEventObject } from '../store'
import { useReadReceipts, useServiceNotices, type ServiceNoticeItem, serviceNoticeFingerprint } from '../lib/use-service-notices'
import { selectDisplacedAgentNotices, displacedAgentStepOutcome } from '../lib/control-spatial-commit'
import { classifyServiceNotice, serviceNoticeToRender, serviceNoticeAriaLive } from '../lib/service-window-notice'
import { NotificationGroup } from './NotificationGroup'
import { groupNotifications, notificationCategories, notificationTimestamp, type NotificationCategory, type NotificationFilter, type NotificationSection, type NotificationSubject } from '../lib/notification-center'
import { createSessionServiceNoticeSelector } from '../lib/session-service-notices'
import { runServiceProjection, useRunServiceHealthChanges } from '../lib/run-service-projection'
import { agentLifecycleFailureNotice } from '../lib/agent-lifecycle-feedback'
import { SettingsNavigation } from './SettingsNavigation'
import { executorsForHost, hostExecutorInventoryMatches } from '../lib/executors'
import { runtimeEndpointNotice } from '../lib/runtime-endpoint-notice'
import { notificationPreview } from '../lib/notification-preview'
import { compactNotificationIdentity } from '../lib/notification-read-identity'
import { registerNotificationReader, type ObservedNotificationEntry, type NotificationProjection } from '../lib/notification-observation'
import type { AgentMuxClientNotificationSubject } from '@agentmux/core/control'

const ThemeObjectNotificationsIcon = semanticIconComponent('object.notifications')
const ThemeNavigationCollapseIcon = semanticIconComponent('action.close')


/** One window-level inbox. Reading a service notice never changes its owner's current facts. */
export function GlobalSystemNotices({ nativeOverlayWarning }: { nativeOverlayWarning?: string | undefined } = {}) {
  const document = useWorkbenchDocument()
  const window = document.defaultView!
  useRunServiceHealthChanges()
  const warning = useAppStore((state) => state.environmentWarning)
  const nameMetadataWarning = useAppStore(state => state.sessionNameMetadataWarning)
  const hosts = useAppStore((state) => state.runtimeOwnershipWarnings)
  const endpointWarnings = useAppStore((state) => state.runtimeEndpointWarnings)
  const config = useAppStore((state) => state.config)
  const startupAgents = useAppStore(state => state.startupAgentAvailability)
  const detections = useAppStore(state => state.executorDetections)
  const inventories = useAppStore(state => state.hostExecutorInventories)
  const detectExecutors = useAppStore(state => state.detectExecutors)
  const settings = useContext(SettingsNavigation)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const displacedIds = useAppStore((state) => state.displacedAgentSessionIds)
  const loading = useAppStore((state) => state.loading)
  const selectSession = useAppStore((state) => state.selectSession)
  const sessionServiceNotices = useMemo(() => createSessionServiceNoticeSelector(), [])
  const sessionNoticeViews = useMemo(() => new WeakMap<ServiceNoticeItem, ServiceNoticeItem>(), [selectSession])
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
  const currentWorkflowErrorId = useMemo(() => currentError &&
    (!errorDismissed || errorContext?.startupSessionSnapshot || errorContext?.startupProviderCatalog) &&
    !errorContext?.lifecycle && !errorContext?.cause ? notificationEventIdentity(currentError, errorContext) : null,
  [currentError, errorDismissed, errorContext])
  const clearReadEvents = useAppStore(state => state.clearReadNotificationEvents)
  // Window records have no complete startup snapshot. Only reading facts persist across restarts.
  const eventReceiptFacts = useMemo(() => Object.fromEntries(events.map(event => [event.id, 'read'])), [events])
  const eventInbox = useReadReceipts('global:events', eventReceiptFacts, !loading, false)
  const currentErrorInbox = useServiceNotices('global:workflow', currentWorkflowErrorId && currentError &&
    !events.some(event => event.id === currentWorkflowErrorId) ? [{ id: 'current', cause: currentWorkflowErrorId, notice: {
      kind: 'indeterminate', notice: { step: errorContext?.summary ?? 'Operation needs attention',
        mode: currentError, restore: 'Review the original operation before retrying.' }
    } }] : [], !loading)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<NotificationSection>('current')
  const [category, setCategory] = useState<NotificationFilter>('all')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const detailsRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const trigger = triggerRef.current, details = detailsRef.current
    if (!open || !trigger || !details) return
    // The explicit popover belongs to its bell. Overlaying the workface never
    // resizes its editors or makes another Region's input height the anchor.
    let disposed = false
    const update = async () => {
      const { x, y } = await computePosition(trigger, details, {
        strategy: 'fixed', placement: 'top-end', middleware: [offset(6), shift({ padding: 8 }), size({ padding: 8,
          apply({ availableHeight }) {
            if (!disposed) details.style.maxHeight = `${Math.max(0, Math.min(480, availableHeight))}px`
          }
        })]
      })
      if (!disposed) Object.assign(details.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
    }
    const stopPosition = autoUpdate(trigger, details, () => { void update() })
    return () => {
      disposed = true
      stopPosition()
      for (const property of ['left', 'top', 'max-height', 'visibility']) details.style.removeProperty(property)
    }
  }, [open, document])
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
  const agentChecks = useMemo((): ServiceNoticeItem[] => {
    const agentHost = config?.hosts.find(host => host.id === startupAgents?.hostId)
    const inventory = agentHost ? inventories[agentHost.id] : undefined
    const failedAgents = executorsForHost(config, agentHost?.id, detections, inventory)
      .filter(executor => executor.detection?.state === 'error' || executor.detection?.state === 'checking' && executor.detection.detail)
    const hostFailure = agentHost && hostExecutorInventoryMatches(inventory, agentHost) && inventory.detail
    const agentFailures = hostFailure ? [inventory.detail!] : failedAgents.map(executor => `${executor.label}: ${executor.detection?.detail ?? 'The executable check did not complete.'}`)
    return agentHost && agentFailures.length ? [{
      id: agentHost.id, cause: JSON.stringify([agentHost, agentFailures]), notice: { kind: 'indeterminate', notice: {
        step: 'Agent availability check needs attention',
        mode: `${agentHost.label}: ${agentFailures.join(' ')} Existing Sessions and launch actions remain available.`,
        restore: 'Check these Agent commands again on the same environment.'
      } }, action: { label: 'Check Agents again', run: () => { void detectExecutors(agentHost.id) } }
    }] : []
  }, [config, startupAgents?.hostId, detections, inventories, detectExecutors])
  const agentChecksInbox = useServiceNotices('global:startup-agent-availability', agentChecks, !loading)
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
  // An unresolved connection remains visible even after its notification is read.
  // The existing owner observation controls its lifetime, not a second UI timer.
  const connectionWarnings = (endpointWarnings ?? []).filter(item => item.observationOrigin !== undefined)
  const connectionLabels = connectionWarnings.map(item =>
    `${config?.hosts.find(host => host.id === item.hostId)?.label ?? item.hostId}: ${item.step}`)
  const displacedKnown = !loading && displacedIds.every((sessionId) => sessions.some((session) => session.id === sessionId))
  const displacedInbox = useServiceNotices('global:displaced-agents', displaced, displacedKnown)
  const sessionOwners = new Map<string, (typeof sessions)[number]>()
  const sessionNotices: ServiceNoticeItem[] = sessions.flatMap(session => sessionServiceNotices(session, queues[session.id], sending[session.id],
    runServiceProjection.read(session),
    !(endpointWarnings ?? []).some(warning => warning.hostId === session.control.hostId &&
      warning.observationOrigin !== undefined))
    .filter(item => item.id !== 'connection' || !(endpointWarnings ?? []).some(warning => warning.scope !== 'observation' && warning.hostId === session.hostId && warning.availability !== 'connected'))
    .map(item => {
      let view = sessionNoticeViews.get(item)
      if (!view) {
        view = { ...item, id: JSON.stringify([session.hostId, session.id, item.id]),
          action: { label: `Open ${session.label} Session`, run: () => selectSession(session.id) } }
        sessionNoticeViews.set(item, view)
      }
      sessionOwners.set(view.id, session)
      return view
    }))
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
  const inboxes = [agentChecksInbox, environmentInbox, ownershipInbox, nameMetadataInbox, endpointInbox, displacedInbox, sessionInbox, storageInbox, chromeInbox, navigationInbox, currentErrorInbox]
  const notices = inboxes.flatMap((inbox) => inbox.notices)
  const currentCount = notices.length + projection.current.length
  const unread = inboxes.reduce((total, inbox) => total + inbox.unread.length, eventInbox.unread.length)
  const available = inboxes.every((inbox) => inbox.available)
  const unreadEventIds = useMemo(() => new Set(eventInbox.unread), [eventInbox.unread])
  const readEvents = open ? projection.history.filter(event => !unreadEventIds.has(event.id)).length : 0
  const latestUnreadEvent = useMemo(() => [...events].reverse().find(event => unreadEventIds.has(event.id)), [events, unreadEventIds])
  const announcement = useMemo(() => latestUnreadEvent
    ? notificationPreview(latestUnreadEvent.context?.summary ?? latestUnreadEvent.message, 'announcement') : '',
  [latestUnreadEvent?.context?.summary, latestUnreadEvent?.message])
  const liveVolume = serviceNoticeAriaLive(latestUnreadEvent?.context?.kind ?? 'indeterminate')
  function navigationAction(action: NonNullable<ServiceNoticeItem['action']>) {
    return { label: action.label, run() { action.run(); detailsRef.current?.hidePopover?.() } }
  }
  function buildEntries(): NotificationProjection {
    const currentEntries: ObservedNotificationEntry[] = []
    const historyEntries: ObservedNotificationEntry[] = []
    const sessionsByIdentity = new Map(sessions.map(session => [JSON.stringify([session.control.hostId, session.id]), session]))
    const sessionIdentity = (session: (typeof sessions)[number] | undefined): AgentMuxClientNotificationSubject => session
      ? { kind: session.kind, hostId: session.control.hostId, ...(session.kind === 'agent' ? { agentSessionId: session.id } : {}), runId: session.control.run.runId }
      : { kind: 'unknown' }
    const sourceSubjects = (scope: string, item: ServiceNoticeItem): AgentMuxClientNotificationSubject => {
      if (scope === 'global:workflow') return { kind: 'unknown' }
      if (scope === 'global:sessions') return sessionIdentity(sessionOwners.get(item.id))
      if (scope === 'global:displaced-agents') return sessionIdentity(sessions.find(session => session.id === item.id))
      if (scope === 'global:startup-agent-availability') return { kind: 'host', hostId: item.id }
      if (scope === 'global:runtime-endpoints') return { kind: 'host', hostId: endpointWarnings![endpoints.findIndex(source => source.id === item.id)]!.hostId }
      return { kind: 'application' }
    }
    const sources = ['startup-agent-availability', 'environment', 'runtime-ownership', 'session-names', 'runtime-endpoints',
      'displaced-agents', 'sessions', 'workbench-save', 'native-chrome', 'desktop-navigation', 'workflow'] as const
    const unavailableSources: NotificationProjection['unavailableSources'] = inboxes.flatMap((inbox, index) => inbox.available ? [] : [sources[index]!])
    if (loading) unavailableSources.push('events')
    const eventPresentation = (event: NotificationEvent) => ({
      timestamp: notificationTimestamp(event.lastObservedAt ?? event.firstObservedAt, (event.occurrences ?? 1) > 1 ? 'Last received' : 'Received'),
      occurrences: event.occurrences
    })
    const eventTimeDetails = (event: NotificationEvent) => {
      const first = notificationTimestamp(event.firstObservedAt, 'Received')
      const last = notificationTimestamp(event.lastObservedAt, 'Last received')
      return [first ? `First received: ${first.dateTime}` : undefined,
        last && last.dateTime !== first?.dateTime ? `Last received: ${last.dateTime}` : undefined].filter(Boolean).join('\n')
    }
    const operationDetails = (record: NotificationEvent) => {
      const original = record.context?.runtimeOperation
      return original ? `Host: ${original.hostId}\nSession: ${original.agentSessionId}\nOperation: ${original.lifecycle.operationId ?? 'unconfirmed'}\nLifecycle operation: ${original.lifecycle.lifecycleOperationId}\n` +
        `Lifecycle: ${original.lifecycle.kind}; phase: ${original.lifecycle.phase}` +
        (original.lifecycle.expectedRun ? `\nExpected Run: ${original.lifecycle.expectedRun.runId}` : '\nRun: unconfirmed') +
        (original.resolvedAt === undefined ? '' : `\nOriginal operation confirmed: ${new Date(original.resolvedAt).toISOString()}`) : undefined
    }
    const priorDetails = (record: NotificationEvent) => record.previousObservations?.map(prior =>
      `Earlier observation (${new Date(prior.observedAt).toISOString()}):\n${prior.message}`).join('\n\n')
    const objectSubject = (object: NotificationEventObject): NotificationSubject => {
      const names: Record<NotificationEventObject['kind'], string> = {
        application: 'Application', host: 'Connection', workspace: 'Workspace', document: 'Document',
        browser: 'Browser', 'tab-group': 'Tab Group', tab: 'Tab', region: 'Region', zone: 'Zone'
      }
      const label = object.kind === 'host' ? config?.hosts.find(host => host.id === object.id)?.label
        : object.kind === 'workspace' ? config?.workspaces.find(workspace => workspace.id === object.id)?.name
        : object.kind === 'tab' ? tabs[object.id]?.name
        : object.kind === 'application' && object.id === 'desktop' ? 'AgentMux' : undefined
      return { key: JSON.stringify(['object', object.kind, object.id, object.hostId, object.workspaceId]),
        label: label ?? names[object.kind], context: label ? names[object.kind] : object.id }
    }
    const append = (inbox: typeof environmentInbox, group: NotificationCategory,
      subject: (item: ServiceNoticeItem) => NotificationSubject, actionLabel?: string) => {
      const unreadIds = new Set(inbox.unread.map(item => item.id))
      for (const item of inbox.notices) currentEntries.push({
        id: JSON.stringify([inbox.scope, item.id]), noticeId: item.id, category: group, subject: subject(item), kind: item.notice.kind,
        title: item.summary?.step ?? item.notice.notice.step,
        impact: item.summary?.mode ?? item.notice.notice.mode,
        get detail() { return [item.notice.notice.step, item.notice.notice.mode, item.notice.notice.restore].join('\n') },
        observation: { source: sources[inboxes.indexOf(inbox)]!, subject: sourceSubjects(inbox.scope, item),
          get version() { return JSON.stringify([serviceNoticeFingerprint(item), item.notice, item.summary]) }, ...(item.observedAt === undefined ? {} : { observedAt: item.observedAt }) },
        unread: unreadIds.has(item.id), onRead: () => inbox.acknowledge([item]), timestamp: notificationTimestamp(item.observedAt),
        action: item.action ? navigationAction({ ...item.action, label: actionLabel ?? item.action.label }) : undefined
      })
    }
    const system = (key: string, label: string) => () => ({ key, label })
    append(agentChecksInbox, 'system', item => ({ key: JSON.stringify(['host-agents', item.id]), label: 'Agent commands', context: config?.hosts.find(host => host.id === item.id)?.label ?? item.id }))
    append(environmentInbox, 'system', system('environment', 'Local environment'))
    append(ownershipInbox, 'system', system('runtime', 'Runtime'))
    append(nameMetadataInbox, 'system', system('session-names', 'Saved Session names'))
    const endpointSubjects = new Map(endpoints.map((item, index) => [item.id, endpointWarnings![index]!.hostId]))
    append(endpointInbox, 'connections', item => {
      const hostId = endpointSubjects.get(item.id)!
      return { key: JSON.stringify(['host', hostId]), label: config?.hosts.find(host => host.id === hostId)?.label ?? hostId }
    })
    append(displacedInbox, 'agents', item => {
      const session = sessions.find(session => session.id === item.id)
      return { key: JSON.stringify(['displaced', session?.control.hostId, item.id]), label: session?.label ?? 'Retained Session' }
    })
    append(sessionInbox, 'agents', item => { const session = sessionOwners.get(item.id)!; return { key: JSON.stringify(['agent', session.control.hostId, session.id, session.control.run.runId]), label: session.label, context: config?.hosts.find(host => host.id === session.control.hostId)?.label ?? session.control.hostId } }, 'View Session')
    append(storageInbox, 'operations', item => ({ key: JSON.stringify(['storage', item.id]), label: item.id === 'workbench-save' ? 'Workbench storage' : 'Name change' }))
    append(chromeInbox, 'system', system('window', 'Application window'))
    append(navigationInbox, 'operations', system('navigation', 'Workspace navigation'))
    append(currentErrorInbox, 'operations', item => ({ key: JSON.stringify(['workflow', item.id]), label: 'Original operation', context: 'Object not recorded' }))
    for (const record of projection.current) {
      const operation = record.context?.runtimeOperation
      const lifecycle = record.context?.lifecycle
      const notice = lifecycle ? agentLifecycleFailureNotice(lifecycle, record.message) : {
        kind: 'indeterminate' as const, notice: {
          step: record.context?.summary ?? 'Operation needs attention', mode: record.message,
          restore: 'Review the original operation before retrying.'
        }
      }
      const subject = lifecycle?.step === 'resume' ? lifecycle.subject : record.context?.subject
      const session = subject?.kind === 'agent' ? sessionsByIdentity.get(JSON.stringify([subject.hostId, subject.agentSessionId]))
        : operation ? sessionsByIdentity.get(JSON.stringify([operation.hostId, operation.agentSessionId])) : undefined
      const launcher = lifecycle?.step === 'launch' ? launcherTabs.get(lifecycle.regionId) : undefined
      const source = lifecycle?.step === 'launch'
        ? `Region ${lifecycle.regionId} · Tab ${launcher?.id ?? lifecycle.tabId}`
        : subject?.kind === 'agent' ? `Host ${subject.hostId} · Session ${subject.agentSessionId} · Run ${subject.run.runId}` : operationDetails(record)
      const target: NotificationSubject = subject?.kind === 'agent'
        ? { key: JSON.stringify(['agent', subject.hostId, subject.agentSessionId, subject.run.runId]), label: session?.label ?? subject.agentSessionId, context: config?.hosts.find(host => host.id === subject.hostId)?.label ?? subject.hostId }
        : lifecycle?.step === 'launch'
          ? { key: JSON.stringify(['region', lifecycle.tabId, lifecycle.regionId]), label: launcher?.name ?? 'Original launch location', context: `Region ${lifecycle.regionId}` }
          : operation ? { key: JSON.stringify(['agent', operation.hostId, operation.agentSessionId]), label: session?.label ?? operation.agentSessionId,
            context: config?.hosts.find(host => host.id === operation.hostId)?.label ?? operation.hostId }
            : { key: record.id, label: 'Original operation', context: 'Object not recorded' }
      currentEntries.push({ ...eventPresentation(record), id: record.id, noticeId: record.id, category: subject?.kind === 'agent' || operation ? 'agents' : 'operations', subject: target,
        kind: notice.kind, title: notice.notice.step, impact: notice.notice.mode,
        get detail() { return [source, eventTimeDetails(record), priorDetails(record), notice.notice.step, notice.notice.mode, notice.notice.restore].filter(Boolean).join('\n') },
        observation: { source: 'events', get version() { return JSON.stringify(record) }, observedAt: record.lastObservedAt ?? record.firstObservedAt,
          subject: subject?.kind === 'agent' ? { kind: 'agent', hostId: subject.hostId, agentSessionId: subject.agentSessionId, runId: subject.run.runId }
            : operation ? { kind: 'agent', hostId: operation.hostId, agentSessionId: operation.agentSessionId,
              ...(operation.lifecycle.operationId ? { operationId: operation.lifecycle.operationId } : {}), ...(operation.lifecycle.expectedRun ? { runId: operation.lifecycle.expectedRun.runId } : {}) }
              : lifecycle?.step === 'launch' ? { kind: 'region', regionId: lifecycle.regionId, tabId: lifecycle.tabId } : { kind: 'unknown' } },
        unread: unreadEventIds.has(record.id), onRead: () => eventInbox.acknowledge([record.id]),
        action: session ? navigationAction({ label: 'View Session', run: () => { void selectSession(session.id) } }) : undefined
      })
    }
    for (const event of [...projection.history].reverse()) {
      const operation = event.context?.runtimeOperation
      const subject = event.context?.subject
      const session = subject?.kind === 'agent' ? sessionsByIdentity.get(JSON.stringify([subject.hostId, subject.agentSessionId]))
        : operation ? sessionsByIdentity.get(JSON.stringify([operation.hostId, operation.agentSessionId])) : undefined
      const origin = event.context?.event, object = origin?.object
      const category: NotificationCategory = origin?.source === 'desktop-notifications' ? 'system'
        : origin?.source === 'spatial' ? 'operations' : origin?.source === 'agent-attention' ? 'agents'
        : object?.kind === 'host' ? 'connections' : object?.kind === 'application' ? 'system'
        : !object && (subject?.kind === 'agent' || operation) ? 'agents' : 'operations'
      const provenance = [origin ? `Source: ${origin.source}\nEvent: ${origin.key}` : undefined,
        object ? `Object: ${object.kind} ${object.id}${object.hostId ? `\nHost: ${object.hostId}` : ''}${object.workspaceId ? `\nWorkspace: ${object.workspaceId}` : ''}` : undefined,
        subject?.kind === 'agent' ? `Session: ${subject.agentSessionId}\nHost: ${subject.hostId}\nRun: ${subject.run.runId}` : undefined,
        operationDetails(event), eventTimeDetails(event), priorDetails(event)].filter(Boolean).join('\n')
      historyEntries.push({ ...eventPresentation(event), id: event.id, eventId: event.id,
        category,
        subject: object ? objectSubject(object) : subject?.kind === 'agent'
          ? { key: JSON.stringify(['agent', subject.hostId, subject.agentSessionId, subject.run.runId]), label: session?.label ?? subject.agentSessionId, context: config?.hosts.find(host => host.id === subject.hostId)?.label ?? subject.hostId }
          : operation ? { key: JSON.stringify(['agent', operation.hostId, operation.agentSessionId]), label: session?.label ?? operation.agentSessionId,
            context: config?.hosts.find(host => host.id === operation.hostId)?.label ?? operation.hostId }
            : { key: event.id, label: 'Operation', context: 'Object not recorded' },
        kind: event.context?.kind ?? 'indeterminate',
        title: event.context?.summary ?? (event.context?.kind === 'agent-broken' ? 'Agent stopped unexpectedly' : event.message),
        detail: event.message, summary: event.context?.summary,
        observation: { source: 'events', get version() { return JSON.stringify(event) }, observedAt: event.lastObservedAt ?? event.firstObservedAt, provenance,
          subject: subject?.kind === 'agent' ? { kind: 'agent', hostId: subject.hostId, agentSessionId: subject.agentSessionId, runId: subject.run.runId }
            : operation ? { kind: 'agent', hostId: operation.hostId, agentSessionId: operation.agentSessionId,
              ...(operation.lifecycle.operationId ? { operationId: operation.lifecycle.operationId } : {}), ...(operation.lifecycle.expectedRun ? { runId: operation.lifecycle.expectedRun.runId } : {}) }
            : object ? { kind: object.kind, objectKey: compactNotificationIdentity(JSON.stringify([object.kind, object.id, object.hostId, object.workspaceId])), ...(object.hostId ? { hostId: object.hostId } : {}), ...(object.workspaceId ? { workspaceId: object.workspaceId } : {}),
              ...(object.kind === 'host' ? { hostId: object.id } : object.kind === 'workspace' ? { workspaceId: object.id } : object.kind === 'tab' ? { tabId: object.id } : object.kind === 'region' ? { regionId: object.id } : {}) } : { kind: 'unknown' } },
        impact: event.context?.summary ? event.message : undefined,
        children: provenance ? <><p className="notification-item__provenance">{provenance}</p><p>{event.message}</p></> : undefined,
        unread: unreadEventIds.has(event.id), onRead: () => eventInbox.acknowledge([event.id]),
        action: session ? navigationAction({ label: 'View Session', run: () => { void selectSession(session.id) } }) : undefined
      })
    }
    return { current: currentEntries, activity: historyEntries, unavailableSources }
  }
  useLayoutEffect(() => registerNotificationReader(buildEntries))
  const visible = open ? buildEntries() : null
  const entries = (section === 'current' ? visible?.current : visible?.activity) ?? []
  const shown = entries.filter(entry => category === 'all' || entry.category === category)
  const groups = groupNotifications(shown)
  const shownUnread = shown.filter(entry => entry.unread)
  function markShownRead() {
    const ids = new Set(shownUnread.map(entry => entry.id))
    for (const inbox of inboxes) inbox.acknowledge(inbox.notices.filter(item => ids.has(JSON.stringify([inbox.scope, item.id]))))
    eventInbox.acknowledge(events.filter(event => ids.has(event.id)).map(event => event.id))
  }
  return <div className="global-system-notices">
    <span className="global-system-notices__announcement" role={liveVolume === 'assertive' ? 'alert' : 'status'} aria-live={liveVolume}>
      {latestUnreadEvent ? `${announcement}. Review system notifications for details.` : ''}
    </span>
    {connectionWarnings.length ? <button type="button" className="global-system-notices__connection"
      aria-label={`Unconfirmed connection observation: ${connectionLabels.join('; ')}. View details`}
      title={connectionWarnings.map((item, index) => `${connectionLabels[index]}\n${item.message}`).join('\n\n')}
      aria-expanded={open} aria-controls={id} popoverTarget={id} popoverTargetAction="show"
      onClick={() => { setSection('current'); setCategory('connections') }}>
      <span className="global-system-notices__connection-dot" aria-hidden="true" />
      <span className="global-system-notices__connection-label">Unconfirmed · {connectionLabels[0]}{connectionWarnings.length > 1 ? ` +${connectionWarnings.length - 1}` : ''}</span>
    </button> : null}
    <button ref={triggerRef} type="button" className="global-system-notices__trigger" data-unread={unread > 0}
      data-attention={events.some(event => unreadEventIds.has(event.id) && event.context?.kind === 'agent-broken') ? 'failure' : 'quiet'}
      aria-label={`System notifications: ${unread} unread, ${currentCount} current, ${projection.history.length} recent events`}
      aria-expanded={open} aria-controls={id} title="System notifications"
      popoverTarget={id} popoverTargetAction="toggle">
      <ThemeObjectNotificationsIcon size={14} aria-hidden="true" />
      {unread ? <span className="global-system-notices__badge" aria-hidden="true">{unread}</span> : null}
    </button>
    <div ref={detailsRef} id={id} popover="auto" className="global-system-notices__details" aria-label="System notifications"
      data-state={open ? 'open' : 'closed'}
      onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.newState === 'open') }}>
      {open ? <>
        <div className="global-system-notices__heading">
          <strong>Notifications</strong>
          <div className="global-system-notices__tabs" role="tablist" aria-label="Notification view">
            {([['current', 'Current', currentCount], ['history', 'Activity', projection.history.length]] as const).map(([value, label, total]) =>
              <button type="button" key={value} role="tab" id={`${id}-${value}`} aria-selected={section === value}
                aria-controls={`${id}-content`} tabIndex={section === value ? 0 : -1} data-section={value}
                onClick={() => setSection(value)} onKeyDown={event => {
                  if (isImeOwnedKeyboardEvent(event)) return
                  const next = event.key === 'Home' ? 'current' : event.key === 'End' ? 'history'
                    : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? value === 'current' ? 'history' : 'current' : undefined
                  if (!next) return
                  event.preventDefault()
                  setSection(next)
                  document.getElementById(`${id}-${next}`)?.focus()
                }}>{label}<span>{total}</span></button>)}
          </div>
          <button type="button" className="icon-button" aria-label="Collapse system notifications" title="Close notifications"
            popoverTarget={id} popoverTargetAction="hide"><ThemeNavigationCollapseIcon size={16} /></button>
        </div>
        <div className="global-system-notices__filters" role="group" aria-label="Notification category">
          {Object.entries(notificationCategories).map(([value, label]) => <button type="button" key={value}
            data-category={value} aria-pressed={category === value} onClick={() => setCategory(value as NotificationFilter)}>{label}</button>)}
        </div>
        <div className="global-system-notices__content" id={`${id}-content`} role="tabpanel" tabIndex={0}
          aria-labelledby={`${id}-${section}`} aria-label={section === 'current' ? 'Current issues' : 'Recent events'}>
          {groups.map(group => <NotificationGroup key={group.id} group={group} />)}
          {!shown.length ? <div className="global-system-notices__empty"><ThemeObjectNotificationsIcon size={24} />
            <strong>{category !== 'all' ? 'No notifications in this category' : section === 'current' ? 'No current issues' : 'No recent activity'}</strong>
            <p>{category !== 'all' ? 'Choose another category to review its notifications.' : section === 'current' ? 'New service issues will appear here. Past events stay in Activity.' : 'New events will appear here with their original details.'}</p>
          </div> : null}
          {!available ? <p className="global-system-notices__observation">Some sources are still being checked. Existing notices are kept.</p> : null}
        </div>
        <div className="global-system-notices__footer">
          <span>{shownUnread.length ? `${shownUnread.length} unread in this view` : 'All read in this view'}</span>
          <div>{section === 'history' && readEvents ? <button type="button" onClick={clearReadEvents} title="Clear read activity across all categories">Clear all read activity</button> : null}
            {shownUnread.length ? <button type="button" onClick={markShownRead}>Mark shown read</button> : null}</div>
        </div>
      </> : null}
    </div>
    <ModalAttachmentDismissal active={Boolean(open && detailsRef.current && getModalOverlayContainer(detailsRef.current))} targetRef={detailsRef}
      onOwnerRemoved={() => detailsRef.current?.hidePopover()}
      onEscapeKeyDown={event => { if (event.defaultPrevented) return; event.preventDefault(); detailsRef.current?.hidePopover() }} />
  </div>
}
