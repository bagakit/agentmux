import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import { observeAgentInputComposition } from '../lib/agent-closeout-input'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import { moteInputSource } from '../lib/mote-input-source'
import type { PendingDeliveryLayout } from '../lib/pending-delivery-layout'
import { useWorkbenchWindowDocument } from '../lib/workbench-document'
import { useObservedAppStore, useObservedConsumerCommit } from '../lib/use-observed-app-store'
import { reportMessageDeliveryDiagnostics } from '../lib/message-delivery-diagnostics'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { NativeConfigurationPicker, PosturePicker } from './PosturePicker'
import { useAgentNativeInformation } from '../lib/use-agent-native-information'
import { useAgentNativeConfiguration } from '../lib/use-agent-native-configuration'
import { createFirstPromptSelector, createSessionViewModeSelector, sessionPresentationById } from '../lib/session-presentation'
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { AgentContextUsage } from './AgentContextUsage'
import { AgentComposerTools } from './AgentComposerTools'
import type { ComposerShortcut, SessionSnapshot } from '../../../shared/contracts'
import type { AgentCatalogEntry } from '@agentmux/core'
import type { SpaceMountMemberTarget } from '../../../shared/space-mount'
import { workspaceOwnsSessionPath } from '@agentmux/host/mote-model'
import { sessionResourceContext } from '../lib/session-resource-context'
import { api } from '../lib/api'
import { useComposerAttachments, type ComposerImageRetention } from '../lib/use-composer-attachments'
import { ComposerFileReferences } from './ComposerFileReferences'
import { expandComposerInput, expandSemanticReferences, type ComposerSemanticReference } from '@agentmux/client-ui/composer-semantic-reference'
import { useComposerCandidates, skillComposerSuggestion } from '../lib/use-composer-candidates'
import { composerSubmitMode, SEND_AFTER_REQUEST_ENDS } from '../lib/composer-submit-mode'
import { interactionNativeComposerBinding } from '../lib/interaction-native-composer-binding'
import {
  caretAtFirstLine,
  caretAtLastLine
} from '../lib/composer-history'
import { ComposerResubmitGuard } from '../lib/composer-resubmit-guard'
import { useAppStore, agentSteerCanEdit, agentSteerExecution, originalMoteRecoveryNotSent, type AgentSteerQueueEntry } from '../store'
import { originalInputDeliveryConfirmed } from '@agentmux/client-ui/input-receipt-projection'
import { steerEntryTargetsRun, steerEntryWakesItself, steerQueueCanEverDrain } from '../lib/agent-steer-queue-drain'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { AgentComposer, type AgentComposerProps } from '@agentmux/client-ui/components/AgentComposer'
import { ComposerSource, type ComposerConnection } from '@agentmux/client-ui/components/ComposerHost'
import { moteComposerSessionKey } from './MoteComposer'
import { useLauncherState } from '../lib/launcher-state'
import { AgentIdentity } from './AgentIdentity'
import { agentProviderLabel } from '@agentmux/client-ui/components/AgentProviderIcon'
import { agentDisplayName } from '../lib/workbench-tabs'
import { ComposerFeedback, useComposerFeedback } from './ComposerFeedback'
import { createSessionServiceNoticeSelector } from '../lib/session-service-notices'
import { useRunService } from '../lib/run-service-projection'
import { SessionMailbox } from './SessionMailbox'
import { useComposerInputHistory, type ComposerInputReading } from '../lib/use-composer-input-history'
import { confirmedSteerDelivery } from '../lib/steer-queue-delivery'
import type { ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import type { RevealMailboxMessage } from '../lib/mailbox-message-navigation'
import { useServiceNotices, type ServiceNoticeItem } from '../lib/use-service-notices'

export type AgentComposerAvailability = {
  disabled: boolean
  placeholder: string
}
async function originalSkillsUnavailable(): Promise<import('@agentmux/core').AgentSkill[]> {
  throw new Error('The original Skills reader is unconfirmed. Refresh its original reading; your draft is kept.')
}
const originalImageRetentionUnavailable: ComposerImageRetention = async () => { throw new Error('The original Run and membership metadata for this image upload are unconfirmed. Refresh the original Session observation; your draft and saved local image are kept.') }

/** One shared identity for "no queue", so the selector returns a stable reference when empty. */
const EMPTY_QUEUE: readonly AgentSteerQueueEntry[] = Object.freeze([])

// The resubmit guard survives a Composer remount within the same application run.
// Drafts remain owned by the store; transient operation feedback stays with the mounted Composer.
const lastSubmitBySession = new ComposerResubmitGuard()

type AgentSession = Extract<SessionSnapshot, { kind: 'agent' }>
type ComposerSessionOwner = Pick<AgentSession['control'], 'hostId' | 'agentSessionId'>

function createComposerSessionReader(sessionId: string, owner: ComposerSessionOwner | null | undefined) {
  return (state: { sessions: readonly SessionSnapshot[] }) => {
    if (owner === null) return undefined
    const session = sessionPresentationById(state.sessions).get(sessionId)
    return !owner || session?.kind === 'agent' && session.control.hostId === owner.hostId &&
      session.control.agentSessionId === owner.agentSessionId ? session : undefined
  }
}

function composerSessionFields(session: SessionSnapshot | undefined, includeRecoveryFacts: boolean) {
  if (!session) return undefined
  const { id, hostId, workspacePath, nativeService, processState, status } = session
  const common = { id, hostId, workspacePath, processState, state: status.state,
    ...(nativeService === undefined ? {} : { nativeService }) }
  if (session.kind === 'terminal') return { ...common, kind: session.kind, control: session.control }
  const { control, providerId, executorId, label, capabilities, inputEpoch, structuredPromptInput, nativeHandle, terminalFrontend,
    toolExecution, workPlacement, pendingInteraction, nativeConfiguration, nativeInformation, turnUsage, contextWindowUsage } = session
  return { ...common, kind: session.kind, control, providerId, executorId, label, capabilities,
    detail: status.detail, continuity: status.continuity, continuityReason: status.continuityReason,
    ...(includeRecoveryFacts && session.continuityOperations ? { continuityOperations: session.continuityOperations } : {}),
    ...(inputEpoch === undefined ? {} : { inputEpoch }), ...(structuredPromptInput ? { structuredPromptInput } : {}),
    ...(nativeHandle ? { nativeHandle } : {}), ...(terminalFrontend ? { terminalFrontend } : {}),
    ...(toolExecution ? { toolExecution } : {}), ...(workPlacement ? { workPlacement } : {}),
    ...(pendingInteraction ? { pendingInteraction } : {}), ...(nativeConfiguration ? { nativeConfiguration } : {}),
    nativeInformation, turnUsage, contextWindowUsage }
}

/** Keep the original service outcome live, including diagnostic times carried by an actual notice. */
function createComposerNoticeSelector() {
  const project = createSessionServiceNoticeSelector()
  let observed: ServiceNoticeItem[] | undefined
  let presented: ServiceNoticeItem[] = []
  let signature = '[]'
  return (...args: Parameters<typeof project>) => {
    const notices = project(...args)
    if (notices !== observed) {
      observed = notices
      const next = JSON.stringify(notices)
      if (next !== signature) { presented = notices; signature = next }
    }
    return presented
  }
}

// The mailbox retains this layout across Composer renders. Its methods need only
// the supplied layout and the original rollover node, not the Composer's Session.
function rolloverDeliveryLayout(pendingLayout: PendingDeliveryLayout | undefined, rolloverSurface: RefObject<HTMLDetailsElement | null>): PendingDeliveryLayout | undefined {
  return pendingLayout ? {
    ...pendingLayout,
    readOverlapTop(popup) {
      const original = pendingLayout.readOverlapTop(popup), surface = rolloverSurface.current
      if (!surface?.isConnected || surface.closest('[hidden], [inert]')) return original
      const rect = surface.getBoundingClientRect()
      return popup.left < rect.right && popup.right > rect.left && popup.top < rect.bottom && popup.bottom > rect.top
        ? Math.min(original ?? rect.top, rect.top) : original
    },
    subscribe(onChange) {
      const stop = pendingLayout.subscribe(onChange), resize = new ResizeObserver(onChange)
      if (rolloverSurface.current) resize.observe(rolloverSurface.current)
      return () => { stop(); resize.disconnect() }
    }
  } : undefined
}


export function agentComposerAvailability(
  session: SessionSnapshot | undefined,
  forceDisabled = false
): AgentComposerAvailability {
  const mode = composerSubmitMode(session, forceDisabled)
  return { disabled: !mode.canSubmit, placeholder: mode.placeholder }
}

/** Direct Session intent keeps its editor; logical Mote intent publishes to its permanent Host. */
function SessionComposerSurface({ source, ...props }: AgentComposerProps & {
  source?: { ownerKey: string; sourceKey: string; enabled: boolean; connection?: ComposerConnection | null | undefined } | undefined
}) {
  return source ? <ComposerSource {...props} {...source} /> : <AgentComposer {...props} />
}

export function AgentSessionComposer({
  pendingLayout,
  sessionId,
  paneSession,
  ownerKey = sessionId,
  providerCatalogEntry,
  resourceWorkspaceId,
  disabled = false,
  readOnly = false,
  tabName,
  aboveInput,
  resultReview,
  reading,
  onRevealMessage,
  onOpenTerminal,
  mailboxOrigin,
  source,
  visible = true
}: {
  pendingLayout?: PendingDeliveryLayout | undefined
  sessionId: string
  /** A Pane binds its exact local original. Null is unconfirmed. Standalone surfaces discover by ID. */
  paneSession?: ComposerSessionOwner | null | undefined
  /** execution.runtimeId + raw SID owns drafts/history/outbox; local Sessions retain session.id. */
  ownerKey?: string
  /** Original Provider capabilities consumed by this Composer; null means no original entry was found. */
  providerCatalogEntry?: AgentCatalogEntry | null | undefined
  resourceWorkspaceId?: string | undefined
  disabled?: boolean
  readOnly?: boolean
  // Authored Tab name is contextual; the Session identity remains primary.
  tabName?: string
  aboveInput?: ReactNode
  reading?: ConversationReadingProps | undefined
  onRevealMessage?: RevealMailboxMessage | undefined
  onOpenTerminal?(): void
  mailboxOrigin?: OpenHttpLinkOrigin | undefined
  resultReview?: ((onNavigate: () => void) => ReactNode) | undefined
  /** Foreign execution facts and locator; drafts and queues still use sessionId as their canonical owner. */
  source?: { target: SpaceMountMemberTarget; session?: SessionSnapshot | undefined; inputReading?: ComposerInputReading | undefined; originalProgress?: import('../../../shared/continuous-progress').OriginalContinuousProgressControl | undefined; originalMail?: import('../lib/use-session-messages').SessionMailReading | undefined; retainImage?: ComposerImageRetention | undefined; onRefreshTools?: (() => void) | undefined } | undefined
  visible?: boolean
}) {
  const moteWorkface = useContext(MoteWorkfaceContext)
  const motePresentation = useWorkbenchBrowserPresentation()
  const moteDialogue = useMoteDialogueView()
  const main = moteDialogue?.page?.main
  useObservedConsumerCommit('composer', visible)
  // Without an explicit Agent from the Pane, keep observing the original source or Session discovery.
  const observeTimeline = visible || Boolean(source) || !paneSession
  const consumerScope = useMemo(() => ({ sessionIds: [...new Set([sessionId, ownerKey])], navigation: false,
    timeline: observeTimeline, sessionActivityTime: visible }), [sessionId, ownerKey, observeTimeline, visible])
  const insertionRef = useRef<ComposerInsertionHandle>(null)
  useEffect(() => { void reportMessageDeliveryDiagnostics() }, [])
  const feedback = useComposerFeedback(ownerKey)
  const memberInput = motePresentation.moteInputIntent === 'member' || Boolean(moteWorkface?.memberIntent)
  const moteComposer = !memberInput && moteWorkface?.presentation === 'conversation' && moteWorkface.section === 'discussion' &&
    moteWorkface.composer?.reference?.sessionId === sessionId ? moteWorkface.composer : undefined
  const moteDraftKey = moteComposer?.draftKey
  const draftOwner = moteDraftKey ?? ownerKey
  // The fixed Host observes the Mote text. A Source only supplies actions and never mirrors that text into a Session.
  const text = useObservedAppStore('composer', visible, consumerScope, state => moteDraftKey ? '' : state.agentComposerDrafts[ownerKey] ?? '')
  const historyNavigation = useObservedAppStore('composer', visible, consumerScope, state => state.agentComposerHistoryNavigation[draftOwner])
  const historyPhase = historyNavigation ? historyNavigation.entries && historyNavigation.cursor < historyNavigation.entries.length
    ? 'browsing' as const : 'restored' as const : undefined
  const setAgentComposerDraft = useAppStore.getState().setAgentComposerDraft
  function readDraft() {
    const record = moteDraftKey ? useLauncherState.getState().drafts[moteDraftKey] : undefined
    return { record, text: moteDraftKey ? record?.prompt ?? '' : useAppStore.getState().agentComposerDrafts[ownerKey] ?? '' }
  }
  function clearDraft(original: ReturnType<typeof readDraft>) {
    if (moteDraftKey) {
      if (useLauncherState.getState().drafts[moteDraftKey] === original.record)
        useAppStore.getState().setAgentComposerDraft(ownerKey, '', moteDraftKey)
    } else useAppStore.getState().clearAgentComposerDraftIfUnchanged(ownerKey, original.text)
  }
  const enqueueDirect = useAppStore.getState().enqueueAgentSteer
  const enqueueAgentSteer: typeof enqueueDirect = (id, value, rejected, operationId, origin, note, options) => enqueueDirect(id, value, rejected, operationId, origin, note,
    { ...options, ...(session?.kind === 'agent' ? { originalSession: session } : {}), ...(source ? { originalMember: source.target } : {}) })
  const archiveAgentSteer = useAppStore.getState().archiveAgentSteer
  const moveAgentSteer = useAppStore.getState().moveAgentSteer
  const sendQueuedAgentSteer = useAppStore.getState().resendRefusedAgentSteer
  // The queue entries, not a count — the badge shows the messages, and derives the count from them, so
  // the two cannot drift. Each entry carries an operationId for retry correlation; only its text renders.
  // Falls back to a shared frozen empty array so an absent queue does not hand a fresh `[]` to the
  // selector on every store update (zustand compares by reference) — the `.map` to text happens once per
  // real render below, not inside the selector, so it does not defeat that reference check.
  const sendingId = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentSteerInFlight?.[ownerKey])
  const sendingPhase = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentSteerInFlightPhase?.[ownerKey])
  const queuedEntries = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentSteerQueues?.[ownerKey] ?? EMPTY_QUEUE)
  const rolloverHandled = useRef<string | null>(null), rolloverChoiceRequired = useRef(false)
  const rollovers = queuedEntries.filter(entry => !entry.archived && entry.mainRollover)
  const rolloverSurface = useRef<HTMLDetailsElement>(null)
  // The existing pending popup must clear the original continuation controls,
  // just as it already clears an interaction card in this workface.
  const deliveryLayout = useMemo(() => rolloverDeliveryLayout(pendingLayout, rolloverSurface), [pendingLayout, rollovers.length > 0])
  const openRollover = (entry: AgentSteerQueueEntry) => {
    if (!entry.mainRollover || !moteWorkface?.startRollover) return
    const accepted = moteWorkface.startRollover({ sessionId, decision: entry.mainRollover, query: { operationId: entry.operationId, prompt: entry.text,
      ...(entry.sourceChannel ? { sourceChannel: entry.sourceChannel } : {}), ...(entry.inputImages ? { inputImages: [...entry.inputImages] } : {}),
      ...(entry.focusTask ? { focusTask: entry.focusTask } : {}) } })
    if (accepted) { rolloverHandled.current = entry.operationId; feedback.dismiss() }
    else feedback.report('这条输入属于原 Mote，当前页面未接纳。原问题和操作已保留；返回所属 Mote 后继续。')
  }
  useEffect(() => {
    if (rollovers.length > 1) rolloverChoiceRequired.current = true
    else if (!rollovers.length) rolloverChoiceRequired.current = false
    if (visible && !memberInput && !rolloverChoiceRequired.current && rollovers.length === 1 && rolloverHandled.current !== rollovers[0]!.operationId) openRollover(rollovers[0]!)
  }, [visible, queuedEntries, memberInput, moteWorkface?.startRollover])
  const executors = useObservedAppStore('composer', visible, consumerScope, (state) => state.config?.executors)
  const readSession = useMemo(() => createComposerSessionReader(sessionId, paneSession), [sessionId, paneSession])
  const includeRecoveryFacts = queuedEntries.some(entry => entry.resumeInputIntent && entry.errorCode === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
  const fields = useObservedAppStore('composer', visible, consumerScope, useShallow(state =>
    source ? undefined : composerSessionFields(readSession(state), includeRecoveryFacts)))
  const observedSession = useMemo(() => fields && (fields.kind === 'terminal' ? { ...fields, status: { state: fields.state } }
    : { ...fields, status: { state: fields.state, ...(fields.detail === undefined ? {} : { detail: fields.detail }),
      ...(fields.continuity === undefined ? {} : { continuity: fields.continuity }),
      ...(fields.continuityReason === undefined ? {} : { continuityReason: fields.continuityReason }) } }), [fields])
  const session = source ? source.session : observedSession
  const moteMain = motePresentation.moteInputIntent !== 'member' && !moteWorkface?.memberIntent && moteDialogue?.target && main?.roleRevision && main.current && session?.kind === 'agent' &&
    main.current.sessionId === session.control.agentSessionId && main.current.hostId === session.control.hostId
    ? { target: moteDialogue.target, expectedRoleRevision: main.roleRevision } : undefined
  const configuredService = useRunService(source ? undefined : session)
  const nativeService = source ? session?.nativeService : configuredService
  const nativeInformation = useAgentNativeInformation(session?.kind === 'agent' ? session.control : undefined, visible,
    session?.kind === 'agent' ? session.nativeInformation : undefined, session?.kind === 'agent' ? session.nativeHandle?.sessionId : undefined)
  const nativeConfiguration = useAgentNativeConfiguration(session?.kind === 'agent' ? session.control : undefined, visible,
    session?.kind === 'agent' ? session.nativeConfiguration : undefined, session?.kind === 'agent' ? session.nativeHandle?.sessionId : undefined)
  const viewModeSelector = useMemo(() => createSessionViewModeSelector(sessionId), [sessionId])
  const viewMode = useObservedAppStore('composer', visible, consumerScope, viewModeSelector)
  const setViewMode = useAppStore.getState().setViewMode
  const userName = useObservedAppStore('composer', visible, consumerScope, (state) => state.agentNames?.[sessionId])
  // The original input owner reconciles queue receipts independently of the Composer.
  // A confirmed hidden Agent's rich input history is only needed on presentation.
  const readTimeline = visible || Boolean(source) || session?.kind !== 'agent'
  const timeline = useObservedAppStore('composer', visible, consumerScope, (state) => readTimeline ? state.timelines?.[sessionId] : undefined)
  // A published preview revision may append to the same original timeline object.
  const timelineRevision = useObservedAppStore('composer', visible, consumerScope, state => readTimeline ? state.timelines?.[sessionId]?.revision : undefined)
  const inputHistory = useComposerInputHistory({ sessionId: ownerKey, draftOwner,
    control: source ? undefined : session?.kind === 'agent' ? session.control : undefined, visible, readOnly: readOnly || disabled,
    insertion: insertionRef, ...(timeline ? { timeline } : {}), ...(source?.inputReading ? { originalReading: source.inputReading } : {}) })
  const firstPromptSelector = useMemo(() => createFirstPromptSelector(sessionId), [sessionId])
  const firstPrompt = useObservedAppStore('composer', visible, consumerScope, state => readTimeline ? firstPromptSelector(state) : null)
  const displayName = session?.kind === 'agent' ? agentDisplayName({
    userName, firstPrompt, fallbackLabel: tabName || session.label, providerLabel: agentProviderLabel(session.providerId)
  }) : undefined
  const config = useObservedAppStore('composer', visible, consumerScope, state => state.config)
  const topicSnapshots = useObservedAppStore('composer', visible, consumerScope, state => state.scratchTopicSnapshots)
  const topics = useMemo(() => scratchTopicsForConfig(config, topicSnapshots), [config, topicSnapshots])
  const toolExecution = session?.kind === 'agent' ? session.toolExecution : undefined
  const runtimeWorkspace = useMemo(() => !source ? config?.workspaces.find(item =>
    session?.kind === 'agent' && workspaceOwnsSessionPath(item, session, topics)
  ) : undefined, [source, config, topics, session?.kind, session?.hostId, session?.workspacePath])
  const resource = useMemo(() => {
    if (source) {
      const workspace = config?.workspaces.find(item => item.id === resourceWorkspaceId)
      return workspace ? { workspace, address: { hostId: workspace.hostId, path: workspace.path } }
        : { issue: 'The original project file Workspace is unconfirmed. Your draft and message queue are kept; open the original project to reference its files.' }
    }
    return sessionResourceContext(config, session, topics, resourceWorkspaceId)
  }, [source, config, topics, resourceWorkspaceId, session?.kind, session?.hostId, session?.workspacePath,
      toolExecution?.resourceHostId, toolExecution?.workspacePath, session?.kind === 'agent' ? session.workPlacement?.resourceHostId : undefined])
  const workspace = resource.workspace
  const activeFile = useObservedAppStore('composer', visible, consumerScope, (state) =>
    workspace ? state.lastActiveFileByWorkspace[workspace.id] : undefined
  )
  // Mounted foreign sources use their original metadata, independently of the local catalogue.
  const observedProviderCatalogEntry = useObservedAppStore('composer', visible, consumerScope, (state) =>
    !source && providerCatalogEntry === undefined && session?.kind === 'agent'
      ? state.providerCatalog.find((entry) => entry.id === session.providerId)
      : undefined
  )
  const originalProviderCatalogEntry = providerCatalogEntry === undefined ? observedProviderCatalogEntry : providerCatalogEntry ?? undefined
  const postureControl = !source && session?.kind === 'agent' ? originalProviderCatalogEntry?.postureControl : undefined
  const composerOptions = session?.kind === 'agent' ? originalProviderCatalogEntry?.composer : undefined
  const sendDirect = useAppStore.getState().send
  const send: typeof sendDirect = (id, value, rejected, origin, note, options) => sendDirect(id, value, rejected, origin, note,
    { ...options, ...(session?.kind === 'agent' ? { originalSession: session } : {}), ...(source ? { originalMember: source.target } : {}) })
  const interrupt = useAppStore.getState().interrupt
  const setPosture = useAppStore.getState().setPosture
  const setConfiguration = useAppStore.getState().setConfiguration
  const reportError = useAppStore.getState().reportError
  // One decision answers three questions the old `availability + isWorking` pair conflated: can the user
  // type, does the surface permit a submit (true while working — that IS steer), and is the primary button
  // Send or Stop. availability stays for other consumers; this component reads only submitMode.
  const submitMode = source && !session
    ? { canType: true, canSubmit: false, primaryAction: 'send' as const, placeholder: 'Original Agent is unconfirmed. Your draft and file tools remain available.' }
    : composerSubmitMode(session, disabled || readOnly)
  const completion = useComposerCandidates({ scope: JSON.stringify([draftOwner, sessionId, session?.hostId, workspace?.id, session?.kind === 'agent' ? session.providerId : null, source?.inputReading?.conversation.identity]),
    active: visible && submitMode.canType, config, resourceWorkspace: workspace, runtimeWorkspace, resourceIssue: resource.issue,
    sessionId: !source && session?.kind === 'agent' ? session.control.agentSessionId : undefined,
    sessionHostId: !source && session?.kind === 'agent' ? session.control.hostId : undefined,
    providerId: !source && session?.kind === 'agent' ? session.providerId : undefined, ...(source ? { originalSkills: source.inputReading?.skills ?? originalSkillsUnavailable } : {}), commands: composerOptions?.commands ?? [], insertion: insertionRef })
  const requestPending = session?.kind === 'agent' && Boolean(session.pendingInteraction)
  const nativeQueuePending = session?.kind === 'agent' && Boolean(interactionNativeComposerBinding(session))

  function acceptsMoteMainInput(): boolean {
    const direct = motePresentation.moteInputIntent === 'member' || moteWorkface?.memberIntent
    const logicalMain = !direct && (motePresentation.moteInputIntent === 'main' || motePresentation.surface === 'mote' || moteWorkface?.section === 'discussion')
    if (logicalMain && !moteMain) {
      feedback.report(main?.status === 'ready'
        ? '主 Agent 已更换或解除绑定。原输入尚未发送，草稿保留；返回当前主对话，或从 Threads 明确选择这位 Agent 继续。'
        : '主对话的原角色来源暂未确认。原输入尚未发送，草稿保留；重读主对话，或从 Threads 明确选择这位 Agent 继续。')
      return false
    }
    return true
  }

  function sendStatusPrompt(prompt: ComposerShortcut): boolean {
    if (disabled || readOnly || !submitMode.canSubmit || !acceptsMoteMainInput()) return false
    // State actions leave the independently authored Composer draft intact.
    if (!send(ownerKey, prompt.body, feedback.report, 'manual', undefined, { moteSource: moteInputSource(sessionId, mailboxOrigin), moteMain })) return false
    feedback.dismiss()
    return true
  }

  function submit(): void {
    const original = readDraft()
    if (!submitMode.canSubmit || !original.text.trim() || !acceptsMoteMainInput()) return
    const { text: value, inputImages } = expandComposerInput(original.text)
    if (lastSubmitBySession.isDuplicate(ownerKey, value)) return
    if (!send(ownerKey, value, feedback.report, 'manual', undefined, { inputImages, moteSource: moteInputSource(sessionId, mailboxOrigin), moteMain,
      ...(original.record?.focusTask ? { focusTask: original.record.focusTask } : {}) })) return
    feedback.dismiss()
    clearDraft(original)
    lastSubmitBySession.record(ownerKey, value)
    useAppStore.getState().recordAgentComposerHistory(ownerKey, value)
  }

  function queue(): void {
    if (!acceptsMoteMainInput()) return
    const original = readDraft()
    const { text: value, inputImages } = expandComposerInput(original.text)
    if (!value.trim()) return
    if (lastSubmitBySession.isDuplicate(ownerKey, value)) return
    // Clear the draft only once the queue has actually taken the text. A refused enqueue (oversized)
    // must leave the words in the box — the store has already said why, and clearing here would strand
    // the user's message in a banner they cannot copy from.
    if (!enqueueAgentSteer(ownerKey, value, feedback.report, undefined, 'manual', undefined, { inputImages, moteSource: moteInputSource(sessionId, mailboxOrigin), moteMain,
      ...(original.record?.focusTask ? { focusTask: original.record.focusTask } : {}) })) return
    feedback.dismiss()
    clearDraft(original)
    void useAppStore.getState().flushAgentSteerQueue(ownerKey)
    lastSubmitBySession.record(ownerKey, value)
    useAppStore.getState().recordAgentComposerHistory(ownerKey, value)
  }

  // A message the person sent while this Mote's Main was still being read. Only the Composer whose Session the role owner
  // confirms as the current Main (moteMain) sends it, once, through the same submit as typing.
  const held = moteWorkface?.heldInput
  const heldStarted = useRef<string | null>(null)
  useEffect(() => {
    if (!held || !visible || !moteMain || !submitMode.canSubmit || heldStarted.current === held.operationId) return
    heldStarted.current = held.operationId
    const { text: value, inputImages } = expandComposerInput(held.prompt)
    const accepted = send(ownerKey, value, feedback.report, 'manual', undefined, { inputImages, moteSource: moteInputSource(sessionId, mailboxOrigin), moteMain,
      ...(held.focusTask ? { focusTask: held.focusTask } : {}) })
    if (accepted) {
      useAppStore.getState().recordAgentComposerHistory(ownerKey, value)
      lastSubmitBySession.record(ownerKey, value)
    }
    moteWorkface?.settleHeldInput?.(held.operationId, accepted)
  }, [held?.operationId, visible, Boolean(moteMain), submitMode.canSubmit])

  // Enter history only at the editing boundary. Once browsing, every plain arrow navigates,
  // including a multiline entry whose editor selection is at its end.
  function historyRecall(direction: 'older' | 'newer', draft: string, caret: number): string | null {
    const state = useAppStore.getState()
    const navigation = state.agentComposerHistoryNavigation[draftOwner]
    const browsing = navigation?.entries && navigation.cursor < navigation.entries.length
    if (!browsing && direction === 'older' && !caretAtFirstLine(draft, caret)) return null
    if (!browsing && direction === 'newer' && !caretAtLastLine(draft, caret)) return null
    return state.recallAgentComposerHistory(ownerKey, direction, draft, inputHistory.entries, moteDraftKey)
  }


  const dialogDocument = useWorkbenchWindowDocument() ?? undefined

  const [fileReferencesOpen, setFileReferencesOpen] = useState(false)
  const onRemoteFiles = useMemo(() => setFileReferencesOpen.bind(null, true), [setFileReferencesOpen])
  const attachmentScope = JSON.stringify([draftOwner, sessionId, session?.hostId, session?.workspacePath, resource.address, workspace?.id, ...(source ? [source.target] : [])])
  useEffect(() => { setFileReferencesOpen(false) }, [attachmentScope, visible])
  const attachments = useComposerAttachments({ scope: attachmentScope, sessionControl: !source && session?.kind === 'agent' ? session.control : undefined, hostId: source ? undefined : session?.hostId,
    ...(source ? { retainImage: source.retainImage ?? originalImageRetentionUnavailable } : {}),
    workspacePath: source ? undefined : session?.workspacePath,
    ...(source || session?.kind === 'agent' && session.toolExecution ? {
      fileResource: workspace ? { hostId: workspace.hostId, workspacePath: workspace.path } : null
    } : {}),
    disabled: !submitMode.canType, insertion: insertionRef, feedback,
    document: dialogDocument, shortcutActive: visible && !readOnly, ...(workspace ? { onRemoteFiles } : {}) })

  const selectNotices = useMemo(createComposerNoticeSelector, [readSession, source?.target])
  const serviceNotices = useObservedAppStore('composer', visible, consumerScope, state =>
    selectNotices(source ? source.session : readSession(state), queuedEntries, sendingId, nativeService))
  const notices: ServiceNoticeItem[] = serviceNotices.map(notice => notice.id === 'timeline-observation'
      ? source ? notice : { ...notice, action: { label: 'Retry work history', run: () => { void useAppStore.getState().resyncTimeline(sessionId, { observationOnly: true }) } } }
      : notice.id === 'interaction-receipt' && onOpenTerminal
        ? { ...notice, action: { label: 'Open terminal', run: onOpenTerminal } }
      : notice)
  if (feedback.failure) notices.push({ id: 'tool', notice: { kind: 'indeterminate', notice: {
    step: 'A message tool action did not complete', mode: feedback.failure.message,
    restore: 'Your draft is kept. Review the original cause and available actions.'
  } }, ...(feedback.failure.retry ? { action: { label: 'Retry', run: feedback.failure.retry } } : {}) })
  const missingSourceTools = source ? [source.originalMail ? '' : 'The original Agent mail reader is unconfirmed.',
    source.inputReading ? '' : 'The original input history and Skills reader are unconfirmed.', source.originalProgress ? '' : 'Automation needs the original Session metadata.',
    source.retainImage ? '' : 'Image upload needs the original Run metadata.'].filter(Boolean) : []
  if (source && missingSourceTools.length) notices.push({ id: 'source-message-tools', occurrence: JSON.stringify(source.target), notice: {
    kind: 'indeterminate', notice: {
      step: 'Some message tools are unavailable on this connection',
      mode: `${missingSourceTools.join(' ')} Your draft and the existing message waiting controls are kept.`,
      restore: 'Refresh the original connection for its missing observations. Available tools keep their original targets; another local Agent is never substituted.'
    }
  } })
  const inbox = useServiceNotices(ownerKey, notices, session?.kind === 'agent')

  const sourceProps = moteComposer ? { ownerKey: moteComposer.draftKey, connection: moteComposer.connection,
    sourceKey: moteComposerSessionKey(moteComposer.reference!, moteMain?.expectedRoleRevision),
    enabled: Boolean(visible && moteComposer.active && moteMain && session?.kind === 'agent' && moteComposer.reference?.hostId === session.control.hostId) } : undefined

  const control = session?.kind === 'agent' ? session.control : undefined
  const compositionOwner = useRef({})
  const capabilities = session?.kind === 'agent' ? session.capabilities : undefined
  const runId = control?.run.runId
  const canDrain = session?.kind === 'agent' && steerQueueCanEverDrain(session.processState)
  const continuityOperations = session?.kind === 'agent' ? session.continuityOperations : undefined
  const presentQueueEntry = useCallback((entry: AgentSteerQueueEntry) => {
    const recoveryNotSent = originalMoteRecoveryNotSent(control, continuityOperations, entry)
    return {
      id: entry.operationId,
      ...(entry.directInputControl && entry.directInputBinding ? { inputOrigin: {
        hostId: entry.directInputControl.hostId, key: entry.inputReceipt?.key ?? { kind: 'prompt' as const,
          agentSessionId: entry.directInputControl.agentSessionId, expectedRun: entry.directInputBinding.expectedRun, submissionId: entry.operationId }
      } } : entry.resumeInputIntent && entry.resumeInputReceipt?.key ? { inputOrigin: {
        hostId: entry.resumeInputIntent.control.hostId, key: entry.resumeInputReceipt.key
      } } : {}),
      text: entry.text,
      ...(entry.archived ? { archived: true as const } : {}),
      inputControlled: Boolean(entry.directInputBinding || entry.resumeInputIntent),
      confirmed: Boolean(entry.resumeInputReceipt && ['launch-carried', 'terminal-confirmed'].includes(entry.resumeInputReceipt.state)) || originalInputDeliveryConfirmed(entry.inputReceipt) || !entry.directInputBinding && Boolean(confirmedSteerDelivery(timeline, control, entry.operationId)),
      ...(entry.inputReceipt ? { inputReceipt: entry.inputReceipt } : {}),
      ...(entry.resumeInputReceipt ? { resumeInputReceipt: entry.resumeInputReceipt } : {}),
      ...(entry.inputStopReceipt ? { inputStopReceipt: entry.inputStopReceipt } : {}),
      ...(entry.enqueuedAt !== undefined ? { enqueuedAt: entry.enqueuedAt } : {}),
      status: entry.status,
      editable: agentSteerCanEdit(entry, sendingId),
      immediateSend: capabilities !== undefined && agentSteerExecution(entry, capabilities) === 'immediate',
      preparing: !entry.archived && entry.operationId === sendingId && sendingPhase !== 'submitting',
      sending: !entry.archived && entry.operationId === sendingId && sendingPhase === 'submitting',
      recoveryNotSent,
      unconfirmed: entry.resumeInputReceipt ? !['launch-carried', 'terminal-confirmed', 'not-applied'].includes(entry.resumeInputReceipt.state) : entry.inputReceipt ? entry.inputReceipt.persistence === 'observed' || entry.inputReceipt.status === 'unknown'
        : !recoveryNotSent && (Boolean(entry.inputIntakeStarted) || entry.promptCondition !== null && !entry.preparationInputNotApplied && (entry.status === 'deferred' || entry.status === 'failed')),
      ...(entry.awaitingExplicitSend ? { awaitingExplicitSend: true as const } : {}),
      wakesItself: runId !== undefined && steerEntryWakesItself(entry, runId),
      deliverable: runId !== undefined && (entry.runId === undefined ||
        canDrain && (steerEntryTargetsRun(entry, runId) ||
          agentSteerCanEdit(entry, sendingId) && entry.goalContinuation === undefined)),
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      ...(entry.logId ? { logId: entry.logId } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.preparationWait ? { preparationWait: entry.preparationWait } : {}),
    }
  }, [control, continuityOperations, capabilities, runId, canDrain, sendingId, sendingPhase, timeline, timelineRevision])
  const queued = useMemo(() => queuedEntries.map(presentQueueEntry), [queuedEntries, presentQueueEntry])
  const sendImmediately = useMemo(() => queued.some(entry => entry.immediateSend), [queued])

  return (
    <SessionMailbox pendingLayout={deliveryLayout} key={sessionId} inputHistory={inputHistory} historyResourceReader={inputHistory.resourceReader} userMessages={inputHistory.messages} onHistoryVisible={inputHistory.setMailboxOpen} mailboxOrigin={mailboxOrigin} reading={reading} onRevealMessage={onRevealMessage} visible={visible} system={inbox} timeline={timeline}
        noticePresentation={feedback.failure ? { id: 'tool', content: <ComposerFeedback compact failure={feedback.failure} onDismiss={feedback.dismiss} /> } : undefined}
        progressSession={!source && !readOnly && session?.kind === 'agent' ? session : undefined}
        originalProgress={!readOnly ? source?.originalProgress : undefined}
        originalMail={source?.originalMail}
        progressUnavailable={source && !source.originalProgress ? { message: 'The original Session Provider and workspace metadata are unconfirmed. Its exact automation target cannot be formed yet. Existing arrangements and your draft are kept.', onRefresh: source.onRefreshTools } : undefined}
        control={source ? null : control}
        queued={queued}
        archiveOwner={source ? { ownerKey, present: presentQueueEntry }
          : control ? { ownerKey, target: control, present: presentQueueEntry } : undefined}
        {...(!readOnly ? { onArchiveQueued: async (operationId: string, expectedText: string, archived: boolean) => {
          await feedback.run(async () => { await archiveAgentSteer(ownerKey, operationId, expectedText, archived) })
        } } : {})}
        {...(!readOnly && session?.kind === 'agent' ? { onMoveQueuedToDraft: async (operationId: string, expectedText: string) => {
          await feedback.run(async () => { await useAppStore.getState().moveQueuedAgentSteerToDraft(ownerKey, operationId, expectedText, session.control.run.runId, moteDraftKey) })
        } } : {})}
        onMoveQueued={(operationId, direction) => moveAgentSteer(ownerKey, operationId, direction)}
        sendImmediately={sendImmediately}
        pendingInteraction={session?.kind === 'agent' && Boolean(session.pendingInteraction)}
        {...(!readOnly ? { onSendQueued: (operationId: string) => { void feedback.run(async () => { await sendQueuedAgentSteer(ownerKey, operationId) }) } } : {})}
        {...(!readOnly ? { onCancelQueuedPreparation: (operationId: string) => { void feedback.run(async () => { await useAppStore.getState().cancelAgentSteerPreparation(ownerKey, operationId) }) } } : {})}
        {...(!disabled && !readOnly ? { onEditQueued: async (id: string, expectedText: string, nextText: string) => {
          feedback.dismiss()
          return useAppStore.getState().editQueuedAgentSteer(ownerKey, id, expectedText, nextText)
        } } : {})}
        onCopyQueued={async (text) => { feedback.dismiss(); return copyTextToClipboard(text, feedback.report) }}
    >
    {(mailbox, pending, composerRef) => (
    <>
    {moteComposer ? aboveInput : null}
    {fileReferencesOpen && workspace && visible ? <ComposerFileReferences key={attachmentScope} workspace={workspace}
      onClose={() => setFileReferencesOpen(false)} onSelect={path => { void attachments.referencePaths([path]) }} /> : null}
    <SessionComposerSurface source={sourceProps} surfaceRef={composerRef} key={sessionId}
      {...(!source && !moteComposer && control ? { onCompositionActivity: (active, interrupted) => {
        observeAgentInputComposition(compositionOwner.current, active ? control : null)
        if (interrupted) {
          const store = useAppStore.getState(), current = store.agentComposerDrafts[draftOwner] ?? ''
          if (current === interrupted.base) store.setAgentComposerDraft(draftOwner, interrupted.draft)
        }
      } } : {})}
      onFocusCapture={event => { inputHistory.setFocused(true); attachments.claimScreenshotTarget(event) }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) inputHistory.setFocused(false) }} active={visible} aboveInput={<>{!moteComposer ? aboveInput : null}{pending}{rollovers.length > 0 && moteWorkface?.startRollover ? <details ref={rolloverSurface} className="mote-conversation__muted" open={rollovers.length === 1}><summary>待承接到新对话的输入</summary>{rollovers.map(entry => <div className="mote-conversation__handoff" data-mote-rollover={entry.operationId} key={entry.operationId}><p style={{ margin: 0, flex: '1 1 12rem' }}>{entry.text.slice(0, 80)}</p><button className="small-button" style={{ flexShrink: 0 }} type="button" onClick={() => openRollover(entry)}>接到新对话</button></div>)}</details> : null}</>} mailbox={mailbox}
      readPastedImage={api.ui.readPastedImage}
      insertionRef={insertionRef}
      identity={session?.kind === 'agent' && displayName ? <AgentIdentity session={session} name={displayName}
        originalStatus={source?.session?.kind === 'agent' ? source.session : undefined}
        executorLabel={executors?.[session.executorId]?.label ?? session.executorId}
        appearance={executors?.[session.executorId]?.avatar} prompts={completion.prompts} visible={visible}
        information={{ information: nativeInformation.information, configuration: nativeConfiguration.snapshot,
          loading: nativeInformation.loading, issue: nativeInformation.issue, onRefresh: nativeInformation.refresh,
          usage: session.turnUsage, contextWindowUsage: session.contextWindowUsage }}
        disabled={!submitMode.canSubmit}
        inputNotice={requestPending || !submitMode.canSubmit || session.processState !== 'running' || session.status.state === 'disconnected'}
        inputAction={!submitMode.canType ? 'Messages are unavailable on this surface.' : requestPending
          ? nativeQueuePending ? 'Send to the Agent’s message queue. The request remains open.' : `${SEND_AFTER_REQUEST_ENDS}.` : !submitMode.canSubmit ? submitMode.placeholder
            : session.processState !== 'running' || session.status.state === 'disconnected'
              ? 'Send to restore this Session.' : 'Send a message to this Session.'}
        onSelect={sendStatusPrompt} resultReview={resultReview} /> : null}
      contextUsage={<AgentContextUsage visible={visible} source={session?.kind === 'agent' ? JSON.stringify([session.hostId, session.id, session.providerId, session.control.run.runId]) : sessionId} usage={session?.kind === 'agent' ? session.turnUsage : undefined} contextWindowUsage={session?.kind === 'agent' ? session.contextWindowUsage : undefined} />}
      {...(workspace || runtimeWorkspace ? { onActivateSemanticReference: (reference: ComposerSemanticReference) => {
        if (reference.kind === 'agent') { void api.ui.openObjectLink(reference.reference).catch(reportError); return }
        const target = reference.kind === 'file' ? workspace : runtimeWorkspace
        if (!target) { feedback.report(new Error(resource.issue ?? 'The original file Workspace is unconfirmed. Your draft and Agent are kept.')); return }
        const path = reference.reference.startsWith('@') ? reference.reference.slice(1) : reference.reference
        const store = useAppStore.getState()
        void store.selectWorkspace(target.id).catch(reportError)
        void store.openFile(path, undefined, undefined, target.id).catch(reportError)
      } } : {})}
      completionConfig={completion.completionConfig}
      commands={completion.commands} skills={completion.skills} references={completion.references}
      promptKeywords={completion.promptKeywords} onCompletionQuery={completion.onCompletionQuery}
      completionFeedback={completion.completionFeedback}
      tools={(referenceTools) => <AgentComposerTools key={completion.scope} active={visible} disabled={!submitMode.canType} commands={completion.commands} referenceTools={referenceTools}
        viewMode={viewMode} onViewModeChange={(mode) => source ? setViewMode(sessionId, mode, { focus: false }) : setViewMode(sessionId, mode)}
        loadSkills={completion.loadSkills} onChooseSkill={skill => { void feedback.run(() => completion.insertCandidate(skillComposerSuggestion(skill))) }}
        onCommand={(_command, candidate) => { void feedback.run(() => completion.insertCandidate(candidate)) }}
        {...(source || session?.hostId === 'local' ? { onCapture: attachments.capture } : {})} runAction={feedback.run} />}
      value={text}
      disabled={!submitMode.canType}
      placeholder={nativeQueuePending ? 'Message the Agent; the request stays open…' : moteWorkface?.mainService && session?.kind === 'agent' &&
        moteWorkface.mainService.hostId === session.control.hostId && moteWorkface.mainService.agentSessionId === session.control.agentSessionId &&
        moteWorkface.mainService.runId === session.control.run.runId ? moteWorkface.mainService.composerHint : submitMode.placeholder}
      primaryAction={submitMode.primaryAction}
      {...(requestPending && !nativeQueuePending ? { submitLabel: SEND_AFTER_REQUEST_ENDS } : {})}
      onHistoryRecall={historyRecall}
      {...(historyPhase ? { historyNavigation: historyPhase } : {})}
      {...(activeFile ? { activeFile } : {})}
      onChange={(value) => setAgentComposerDraft(ownerKey, value, moteDraftKey)}
      // Interrupt follows `primaryAction`, never `canSubmit`: composer-submit-mode.ts answers "is a turn in
      // flight" and "may Enter submit" separately, so Stop stays wired whatever the submit axis says,
      // including while a request card is up. Core's interrupt path (client.signalAgent → kernel.interrupt)
      // has no pendingInteraction or processState gate, so withholding it here would take away a capability
      // the runtime still honours (RED-LINES.md 判定流程 question 2).
      {...(submitMode.primaryAction === 'stop' ? { onInterrupt: () => { void (source ? interrupt(ownerKey, source.target) : interrupt(ownerKey)) } } : {})}
      // Resource helpers edit the existing draft, including while a request is pending.
      // Submission eligibility stays with Core; it does not disable local drafting.
      {...(submitMode.canType ? {
        onAttach: () => { void attachments.chooseFiles() },
        onPasteImage: attachments.pasteImage,
        onDropFiles: attachments.dropFiles,
        ...(activeFile ? { onReferenceActiveFile: () => { void attachments.referencePaths([activeFile]) } } : {})
      } : {})}
      {...(submitMode.canSubmit ? { onSubmit: () => void submit() } : {})}
      {...(session?.kind === 'agent' ? {
        configurationTool: <NativeConfigurationPicker key={JSON.stringify([session.control, session.nativeHandle?.sessionId])}
          snapshot={nativeConfiguration.snapshot} information={nativeInformation.information} loading={nativeConfiguration.loading} issue={nativeConfiguration.issue}
          disabled={readOnly || disabled || Boolean(source) || session.processState !== 'running'} onRefresh={async () => { await nativeConfiguration.refresh().catch(() => {}) }}
          onInspect={operationId => useAppStore.getState().inspectConfigurationOperation(sessionId, operationId)}
          onSet={async (configId, value, revision) => {
            const target = nativeConfiguration.target ?? (await nativeConfiguration.refresh()).target
            return await setConfiguration(sessionId, { target, expectedRevision: revision, configId, value })
          }} />
      } : {})}
      // Typed Send may restore a Session. Posture is a raw keystroke for the current live Run; it cannot be
      // buffered or replayed through that restoration boundary. Core writes it like any terminal input, so
      // while a request is pending it would land in the open native dialog and be recorded as native input
      // on that request, retiring the card's answer. It is offered only when no request owns the input.
      {...(!nativeConfiguration.snapshot?.options.length && postureControl && submitMode.canSubmit && session?.kind === 'agent' && !session.pendingInteraction &&
        session.processState === 'running' && session.status.state !== 'disconnected'
        ? { postureTool: <PosturePicker control={postureControl} disabled={!submitMode.canType} onSet={(modeId: string) => void setPosture(sessionId, modeId)} /> } : {})}
      {...(session?.kind === 'agent' && (moteDraftKey || text.trim()) && (session.pendingInteraction || submitMode.primaryAction === 'stop') ? {
        onQueue: () => queue()
      } : {})}
    />
    </>
    )}
    </SessionMailbox>
  )
}
