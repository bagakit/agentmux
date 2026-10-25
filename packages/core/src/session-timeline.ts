import { parseAgentInputImages } from './agent-input-resource.js'
import { parseExternalConversationAuthor, parseExternalConversationInputObservation } from './external-conversation.js'
import { agentInputContextCaptureProofFields } from './agent-input-context-capture.js'
import { conversationRevision } from './conversation-stream.js'
import { parseAgentExternalMessageAuthor } from './external-author.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { parseAgentInputJournalCut, parseAgentInputSubmissionObservation } from './agent-input-conversation.js'
import { conversationProvenanceFields } from './conversation-provenance.js'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
import { AgentMuxError } from './errors.js'
import { browserInputContextFields } from './browser-input-context.js'
import { isAgentActivityStatusSource, semanticStatusStale } from './agent-status-freshness.js'
import { applyNormalizedTimelineMutation, MAX_TIMELINE_ITEMS_PER_WINDOW } from './session-timeline-reducer.js'
import type {
  AgentActivityState,
  AgentDisplayState,
  AgentMuxRunRef,
  AgentStatus,
  AgentWorkHistoryProjection,
  AgentActivityHistoryProjection,
  AgentMuxAcpEvent,
  AgentMuxEvidence,
  AgentMuxEvidenceSource,
  AgentTimelineItem,
  AgentTimelineItemKind,
  AgentTimelineItemStatus,
  AgentTimelineMutation,
  AgentTimelineSnapshot,
  AgentMuxClientEvent
} from './types.js'

export type {
  AgentActivityState,
  AgentWorkHistoryProjection,
  AgentActivityHistoryProjection,
  AgentTimelineCommit,
  AgentTimelineItem,
  AgentTimelineItemKind,
  AgentTimelineItemStatus,
  AgentTimelineMutation,
  AgentTimelineSnapshot
} from './types.js'

export const MAX_AGENT_TIMELINE_STATUS_ITEMS = MAX_TIMELINE_ITEMS_PER_WINDOW
export const MAX_AGENT_TIMELINE_INPUT_ITEMS = MAX_TIMELINE_ITEMS_PER_WINDOW
export const MAX_AGENT_TIMELINE_ITEMS = 3 * MAX_TIMELINE_ITEMS_PER_WINDOW
const MAX_TIMELINE_MUTATION_BYTES = 128 * 1024
const UTF8_ENCODER = new TextEncoder()
// These three arrays are the sole runtime validation gate in `normalizeItem`. A plain
// `readonly X[]` literal annotation only enforces ⊆ (every listed string is a union member); it is
// blind to ⊇ (every union member is listed). Adding a member to a union in types.ts and forgetting
// to list it here would silently REJECT every legitimate timeline item carrying the new member with
// INVALID_AGENT_TIMELINE — a fail-closed data drop with NO compile error, and addition is the
// common direction. Projecting each array off a total `Record<Union, true>` table turns BOTH
// directions into a compile error at THIS file: a missing key errors (TS2741 — the ⊇ drift this
// guards, kills the mutation "add a union member, forget the table entry"), and an extra key errors
// (TS2353 — a stale entry left after a member is removed). Measured in this repo (session-timeline
// via `npx tsc --noEmit`): the explicit `Record<Union, true>` annotation errors on a missing key AND
// on an extra key; that is the load-bearing thing here, not any runtime `.includes` check — a
// hand-written array is behaviourally identical to this projection, so only the compiler catches the
// drift. Blind spot: it does not check the ORDER of members, only their exact set.
const KIND_MEMBERS: Record<AgentTimelineItemKind, true> = {
  system_message: true,
  user_message: true,
  assistant_message: true,
  tool_call: true,
  permission: true,
  lifecycle: true
}
const KINDS = Object.keys(KIND_MEMBERS) as readonly AgentTimelineItemKind[]
const STATUS_MEMBERS: Record<AgentTimelineItemStatus, true> = {
  recorded: true,
  streaming: true,
  complete: true,
  failed: true
}
const STATUSES = Object.keys(STATUS_MEMBERS) as readonly AgentTimelineItemStatus[]
const SOURCE_MEMBERS: Record<AgentMuxEvidenceSource, true> = {
  'terminal-output': true,
  'run-process': true,
  'native-hook': true,
  'native-transcript': true,
  acp: true,
  user: true,
  agentmux: true
}
const SOURCES = Object.keys(SOURCE_MEMBERS) as readonly AgentMuxEvidenceSource[]

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Timeline mutation must be an object.', 'INVALID_AGENT_TIMELINE')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || /\0/u.test(value)) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_TIMELINE')
  }
  return value
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_TIMELINE')
  }
  return value as number
}

function optionalText(
  source: Record<string, unknown>,
  name: string,
  allowEmpty = true
): string | undefined {
  return source[name] === undefined ? undefined : text(source[name], name, allowEmpty)
}

function optionalField(
  source: Record<string, unknown>,
  name: string,
  allowEmpty = true
): Record<string, string> {
  const value = optionalText(source, name, allowEmpty)
  return value === undefined ? {} : { [name]: value }
}


function acpTimelineItemId(
  evidence: AgentMuxEvidence,
  kind: 'activity' | 'permission',
  rawId: string
): string {
  if (evidence.source !== 'acp') {
    throw new AgentMuxError('ACP Timeline evidence source is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  return JSON.stringify([
    'acp',
    text(evidence.acpAdapterId, 'ACP adapter id'),
    text(evidence.acpSessionId, 'ACP Session id'),
    kind,
    text(rawId, 'ACP event id')
  ])
}

const DISPLAY_STATES: Record<AgentDisplayState, true> = {
  starting: true, running: true, disconnected: true, working: true, waiting: true,
  blocked: true, done: true, exited: true, error: true
}
const ACTIVITY_BOUNDARIES: Record<Extract<AgentActivityState, { boundary: string }>['boundary'], true> = {
  exited: true, interrupted: true, lost: true, restored: true, 'history-gap': true
}

export function normalizeAgentActivityState(value: unknown): AgentActivityState {
  const source = record(value)
  const run = record(source.run)
  const common = {
    run: { runId: text(run.runId, 'Activity Run id') },
    ...optionalField(source, 'previousObservationId', false)
  }
  if (source.state !== undefined && source.boundary === undefined &&
    Object.hasOwn(DISPLAY_STATES, source.state as string)) {
    return { ...common, state: source.state as AgentDisplayState,
      ...(source.stateEnteredAt === undefined ? {} : { stateEnteredAt: timestamp(source.stateEnteredAt, 'Activity stateEnteredAt') }) }
  }
  if (source.state === undefined && source.boundary !== undefined &&
    Object.hasOwn(ACTIVITY_BOUNDARIES, source.boundary as string)) {
    return { ...common, boundary: source.boundary as Extract<AgentActivityState, { boundary: string }>['boundary'] }
  }
  throw new AgentMuxError('Activity state observation is invalid.', 'INVALID_AGENT_TIMELINE')
}

export function normalizeAgentTimelineItem(value: unknown): AgentTimelineItem {
  const source = record(value)
  if (!KINDS.includes(source.kind as AgentTimelineItemKind)) {
    throw new AgentMuxError('Timeline item kind is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  if (!STATUSES.includes(source.status as AgentTimelineItemStatus)) {
    throw new AgentMuxError('Timeline item status is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  if (!SOURCES.includes(source.source as AgentMuxEvidenceSource)) {
    throw new AgentMuxError('Timeline item source is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  const createdAt = timestamp(source.createdAt, 'Timeline item createdAt')
  const updatedAt = timestamp(source.updatedAt, 'Timeline item updatedAt')
  if (updatedAt < createdAt) {
    throw new AgentMuxError('Timeline item update precedes creation.', 'INVALID_AGENT_TIMELINE')
  }
  if (source.authorHuman !== undefined && typeof source.authorHuman !== 'boolean') {
    throw new AgentMuxError('Timeline item authorHuman is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  const contentEligibility = source.contentEligibility
  if (contentEligibility !== undefined && contentEligibility !== 'public' && contentEligibility !== 'private' && contentEligibility !== 'unconfirmed') {
    throw new AgentMuxError('Timeline content purpose is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  const authorAgent = optionalField(source, 'authorAgentSessionId')
  if (source.publicContent !== undefined && (source.publicContent !== 'confirmed' || source.kind !== 'user_message' ||
    source.source !== 'user' || typeof source.content !== 'string' || !source.content)) {
    throw new AgentMuxError('Timeline user-content boundary is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  const a2aNotificationId = source.a2aNotificationId === undefined ? undefined : text(source.a2aNotificationId, 'A2A notification input ID')
  if (a2aNotificationId !== undefined && (source.kind !== 'system_message' || source.source !== 'agentmux' ||
      source.authorHuman !== undefined || source.authorAgentSessionId !== undefined || source.authorExternal !== undefined)) throw new AgentMuxError(
    'An A2A notification must retain its original platform source.', 'INVALID_AGENT_TIMELINE')
  const externalInput = source.externalInput === undefined ? undefined : parseExternalConversationInputObservation(source.externalInput)
  if (externalInput && (source.authorExternal === undefined || source.kind !== 'user_message' || source.source !== 'user')) throw new AgentMuxError('An ingress observation requires its original external conversation record.', 'INVALID_AGENT_TIMELINE')
  const inputRef = source.inputRef === undefined ? undefined : validateAgentPromptInputKey(source.inputRef)
  const inputOrigin = source.inputOrigin === undefined ? undefined : parseAgentInputJournalCut(source.inputOrigin)
  const inputSubmission = source.inputSubmission === undefined ? undefined : parseAgentInputSubmissionObservation(source.inputSubmission)
  if (source.status === 'recorded' && !inputOrigin) throw new AgentMuxError('Recorded input status needs its original saved-input membership.', 'INVALID_AGENT_TIMELINE')
  if ((inputOrigin || inputSubmission) && (!inputOrigin || inputOrigin.sequence < 1 || !inputSubmission || !inputRef ||
      !(inputRef.kind === 'prompt' && source.authorHuman === true && source.authorExternal === undefined || inputRef.kind === 'message' && source.authorExternal !== undefined && source.authorHuman !== true) || source.authorAgentSessionId !== undefined)) throw new AgentMuxError(
    'A saved input projection requires its original journal membership, author and receipt.', 'INVALID_AGENT_TIMELINE')
  if (inputRef && (inputRef.agentSessionId !== source.agentSessionId || !(source.kind === 'user_message' && source.source === 'user' && source.publicContent === 'confirmed' ||
      source.kind === 'system_message' && source.source === 'agentmux' && a2aNotificationId !== undefined && inputRef.kind === 'prompt' && inputRef.submissionId === a2aNotificationId)))
    throw new AgentMuxError('Timeline input identity does not describe its original public user submission.', 'INVALID_AGENT_TIMELINE')
  if (a2aNotificationId !== undefined && (!inputRef || inputRef.kind !== 'prompt' || inputRef.submissionId !== a2aNotificationId)) throw new AgentMuxError('A platform notification requires its exact original input key.', 'INVALID_AGENT_TIMELINE')
  if (source.authorExternal !== undefined && (authorAgent.authorAgentSessionId !== undefined || source.authorHuman === true)) throw new AgentMuxError('External attribution cannot claim another author.', 'INVALID_AGENT_TIMELINE')
  if (source.activityState !== undefined && source.kind !== 'lifecycle') {
    throw new AgentMuxError('Activity state requires a lifecycle item.', 'INVALID_AGENT_TIMELINE')
  }
  return {
    id: text(source.id, 'Timeline item id'),
    agentSessionId: text(source.agentSessionId, 'Timeline Agent Session id'),
    kind: source.kind as AgentTimelineItemKind,
    status: source.status as AgentTimelineItemStatus,
    source: source.source as AgentMuxEvidenceSource,
    createdAt,
    updatedAt,
    title: text(source.title, 'Timeline item title'),
    ...(source.inputImages === undefined ? {} : { inputImages: parseAgentInputImages(source.inputImages) }),
    ...browserInputContextFields(source), ...agentInputContextCaptureProofFields(source),
    ...optionalField(source, 'content'),
    ...(contentEligibility === undefined ? {} : { contentEligibility }),
    ...(source.publicContent === undefined ? {} : { publicContent: 'confirmed' as const }),
    ...(inputRef ? { inputRef } : {}),
    ...(externalInput ? { externalInput } : {}),
    ...(inputOrigin ? { inputOrigin, inputSubmission: inputSubmission! } : {}),
    ...(a2aNotificationId === undefined ? {} : { a2aNotificationId }),
    ...authorAgent,
    ...(source.authorExternal === undefined ? {} : { authorExternal: ('grantId' in Object(source.authorExternal) ? parseAgentExternalMessageAuthor(source.authorExternal) : parseExternalConversationAuthor(source.authorExternal)) }),
    ...(source.sourceDevice === undefined ? {} : { sourceDevice: normalizeOperationDevice(source.sourceDevice) }),
    ...(source.sourceChannel === undefined ? {} : { sourceChannel: normalizeMessageChannel(source.sourceChannel) }),
    ...(authorAgent.authorAgentSessionId === undefined && source.authorHuman === true ? { authorHuman: true } : {}),
    ...optionalField(source, 'toolName'),
    ...optionalField(source, 'toolInput'),
    ...optionalField(source, 'toolOutput'),
    ...optionalField(source, 'eventName'),
    ...conversationProvenanceFields(source),
    ...(source.activityState === undefined ? {} : { activityState: normalizeAgentActivityState(source.activityState) })
  }
}

export function normalizeAgentTimelineMutation(value: unknown): AgentTimelineMutation {
  if (UTF8_ENCODER.encode(JSON.stringify(value)).byteLength > MAX_TIMELINE_MUTATION_BYTES) {
    throw new AgentMuxError('Timeline mutation exceeds the maximum size.', 'AGENT_TIMELINE_TOO_LARGE')
  }
  const source = record(value)
  if (Object.hasOwn(source, 'contentDelta')) {
    throw new AgentMuxError(
      'Timeline updates require complete content.',
      'INVALID_AGENT_TIMELINE'
    )
  }
  const agentSessionId = text(source.agentSessionId, 'Timeline Agent Session id')
  if (source.type === 'append' || source.type === 'upsert') {
    const item = normalizeAgentTimelineItem(source.item)
    if (item.agentSessionId !== agentSessionId) {
      throw new AgentMuxError('Timeline item belongs to another Agent Session.', 'INVALID_AGENT_TIMELINE')
    }
    return { type: source.type, agentSessionId, item }
  }
  if (source.type !== 'update') {
    throw new AgentMuxError('Timeline mutation type is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  if (source.status !== undefined && !STATUSES.includes(source.status as AgentTimelineItemStatus)) {
    throw new AgentMuxError('Timeline item status is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  return {
    type: 'update',
    agentSessionId,
    itemId: text(source.itemId, 'Timeline item id'),
    updatedAt: timestamp(source.updatedAt, 'Timeline item updatedAt'),
    ...(source.status === undefined ? {} : { status: source.status as AgentTimelineItemStatus }),
    ...optionalField(source, 'title', false),
    ...optionalField(source, 'content'),
    ...optionalField(source, 'toolName'),
    ...optionalField(source, 'toolInput'),
    ...optionalField(source, 'toolOutput'),
    ...optionalField(source, 'eventName')
  }
}

export function applyAgentTimelineMutation(
  current: readonly AgentTimelineItem[],
  value: AgentTimelineMutation
): AgentTimelineItem[] {
  const mutation = normalizeAgentTimelineMutation(value)
  const items = current.map((item) => normalizeAgentTimelineItem(item))
  if (items.some((item) => item.agentSessionId !== mutation.agentSessionId)) {
    throw new AgentMuxError('Timeline contains another Agent Session.', 'INVALID_AGENT_TIMELINE')
  }
  return applyNormalizedTimelineMutation(items, mutation)
}

/** Apply only an exact committed captured delta; an observation gap never replaces the old reading. */
export function applyAgentTimelineEvent(snapshot: AgentTimelineSnapshot,
  event: Extract<AgentMuxClientEvent, { type: 'agent-timeline' }>): { snapshot: AgentTimelineSnapshot; gap: boolean } {
  const gap = () => ({ snapshot, gap: true })
  if (snapshot.agentSessionId !== event.agentSessionId) return gap()
  if (event.revision <= snapshot.revision) return { snapshot, gap: false }
  const stream = event.stream, position = event.position
  if (!stream || !position || typeof event.sourceHostId !== 'string' || !event.sourceHostId ||
    snapshot.sourceHostId !== undefined && snapshot.sourceHostId !== event.sourceHostId ||
    typeof stream.epoch !== 'string' || !stream.epoch || !['beginning', 'retained-prefix', 'unknown'].includes(stream.origin) ||
    !Array.isArray(stream.gaps) || !stream.gaps.every(row => row && typeof row.code === 'string' && typeof row.message === 'string') ||
    !Number.isSafeInteger(stream.sequence) || stream.sequence < 1 || !Number.isSafeInteger(stream.revision) ||
    stream.revision !== event.revision || event.revision !== snapshot.revision + 1 ||
    position.sequence !== stream.sequence || !Number.isSafeInteger(position.firstSequence) || position.firstSequence < 1 ||
    position.firstSequence > position.sequence || typeof position.revision !== 'string') return gap()
  const previous = snapshot.stream
  if (previous ? previous.epoch !== stream.epoch || stream.sequence !== previous.sequence + 1
    : snapshot.items.length !== 0 || snapshot.revision !== 0 || stream.sequence !== 1) return gap()
  try {
    const mutation = normalizeAgentTimelineMutation(event.mutation)
    const id = mutation.type === 'update' ? mutation.itemId : mutation.item.id
    if (mutation.agentSessionId !== snapshot.agentSessionId || position.id !== id) return gap()
    const original = previous?.positions.find(row => row.id === id)
    if (original && original.firstSequence !== position.firstSequence || !original && position.firstSequence < position.sequence) return gap()
    const items = applyNormalizedTimelineMutation(snapshot.items, mutation), changed = items.find(item => item.id === id)
    if (!changed || conversationRevision(changed) !== position.revision) return gap()
    const retained = new Set(items.map(item => item.id))
    const positions = (previous?.positions ?? []).filter(row => retained.has(row.id))
      .map(row => row.id === id ? { ...position } : row)
    if (!original) positions.push({ ...position })
    return { snapshot: { ...snapshot, sourceHostId: event.sourceHostId, revision: event.revision, items,
      stream: { ...stream, gaps: stream.gaps.map(row => ({ ...row })), positions } }, gap: false }
  } catch { return gap() }
}

export function normalizeAgentTimeline(
  agentSessionId: string,
  values: readonly unknown[]
): AgentTimelineItem[] {
  if (!Array.isArray(values) || values.length > MAX_AGENT_TIMELINE_ITEMS) {
    throw new AgentMuxError('Agent Timeline exceeds its item limit.', 'AGENT_TIMELINE_LIMIT')
  }
  const normalized = values.map(normalizeAgentTimelineItem)
  const states = normalized.filter((item) => item.activityState !== undefined).length
  const inputs = normalized.filter((item) => !item.activityState && item.kind === 'user_message').length
  if (states > MAX_AGENT_TIMELINE_STATUS_ITEMS || inputs > MAX_TIMELINE_ITEMS_PER_WINDOW ||
    normalized.length - inputs - states > MAX_TIMELINE_ITEMS_PER_WINDOW) {
    throw new AgentMuxError('Agent Timeline exceeds its retention window.', 'AGENT_TIMELINE_LIMIT')
  }
  return normalized.reduce<AgentTimelineItem[]>((items, item) => applyNormalizedTimelineMutation(items, normalizeAgentTimelineMutation({
    type: 'append',
    agentSessionId,
    item
  })), [])
}

export function agentTimelineMutationFromAcpEvent(
  agentSessionId: string,
  event: AgentMuxAcpEvent,
  evidence: AgentMuxEvidence
): AgentTimelineMutation | null {
  if (event.type === 'activity') {
    if (Object.hasOwn(event, 'contentDelta')) {
      throw new AgentMuxError(
        'ACP activity updates require complete content.',
        'INVALID_AGENT_TIMELINE'
      )
    }
    if (event.operation === 'append') {
      return normalizeAgentTimelineMutation({
        type: 'append',
        agentSessionId,
        item: {
          id: acpTimelineItemId(evidence, 'activity', event.activityId),
          agentSessionId,
          kind: event.kind,
          status: event.status,
          source: 'acp',
          createdAt: evidence.observedAt,
          updatedAt: evidence.observedAt,
          title: event.title,
          ...(event.content === undefined ? {} : { content: event.content }),
          ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
          ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput })
        }
      })
    }
    return normalizeAgentTimelineMutation({
      type: 'update',
      agentSessionId,
      itemId: acpTimelineItemId(evidence, 'activity', event.activityId),
      updatedAt: evidence.observedAt,
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.title === undefined ? {} : { title: event.title }),
      ...(event.content === undefined ? {} : { content: event.content }),
      ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
      ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput })
    })
  }
  if (event.type !== 'permission') return null
  return normalizeAgentTimelineMutation({
    type: 'append',
    agentSessionId,
    item: {
      id: acpTimelineItemId(evidence, 'permission', event.requestId),
      agentSessionId,
      kind: 'permission',
      status: 'complete',
      source: 'acp',
      createdAt: evidence.observedAt,
      updatedAt: evidence.observedAt,
      title: event.title,
      ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
      ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput })
    }
  })
}

/** Pure projection of the already bounded typed window. Reading never creates work facts. */
export function projectAgentActivityHistory(
  items: readonly AgentTimelineItem[],
  options: {
    now?: number
    current?: { run: AgentMuxRunRef; processState: 'running' | 'exited' | 'interrupted' | 'unknown'; semanticStatus?: AgentStatus; available: boolean }
  } = {}
): AgentActivityHistoryProjection {
  const observations = items.filter((item) => item.activityState !== undefined)
  const byId = new Map(observations.map((item) => [item.id, item]))
  const successors = new Map<string, AgentTimelineItem[]>()
  const coverage = { recorded: observations.length > 0, truncated: false, gaps: false }
  for (const item of observations) {
    const previous = item.activityState!.previousObservationId
    if (!previous) continue
    if (!byId.has(previous)) { coverage.truncated = true; coverage.gaps = true }
    const next = successors.get(previous) ?? []
    next.push(item)
    successors.set(previous, next)
  }
  const tails = observations.filter(item => !successors.has(item.id))
  const uniqueTailId = tails.length === 1 ? tails[0]!.id : undefined
  const segments: AgentActivityHistoryProjection['segments'] = []
  for (const item of observations) {
    const activity = item.activityState!
    if ('boundary' in activity) {
      if (activity.boundary === 'lost' || activity.boundary === 'history-gap') coverage.gaps = true
      continue
    }
    const trusted = isAgentActivityStatusSource(item.source)
    const state = activity.state === 'working' ? 'working' : !trusted ? 'unknown'
      : activity.state === 'done' || activity.state === 'error' ? 'idle'
      : activity.state === 'waiting' || activity.state === 'blocked' ? 'awaiting-input' : 'unknown'
    const segment: AgentActivityHistoryProjection['segments'][number] = {
      state, observationId: item.id, ...(activity.state === 'error' ? { detail: item.content ?? item.title } : {}),
      run: { ...activity.run }, startAt: item.createdAt, endAt: null, end: 'unknown',
      startKnown: activity.stateEnteredAt === item.createdAt
    }
    if (!segment.startKnown && state === 'working') coverage.gaps = true
    const following = successors.get(item.id) ?? []
    const next = following.length === 1 ? following[0] : undefined
    if (next && next.createdAt > item.createdAt && next.activityState!.run.runId === activity.run.runId) {
      const state = next.activityState!
      segment.endAt = next.createdAt
      segment.end = 'boundary' in state
        ? state.boundary === 'exited' || state.boundary === 'interrupted' ? 'run-ended' : 'observation-gap'
        : state.state !== activity.state ? 'state-change' : 'unknown'
    } else if (state === 'working' && !next && following.length === 0 && uniqueTailId === item.id &&
      options.current?.available === true && options.current.processState === 'running' &&
      options.current.run.runId === activity.run.runId && options.current.semanticStatus?.state === 'working' &&
      activity.stateEnteredAt !== undefined && options.current.semanticStatus.stateEnteredAt === activity.stateEnteredAt &&
      options.now !== undefined && Number.isSafeInteger(options.now) && options.now >= item.createdAt &&
      !semanticStatusStale(options.current.semanticStatus, options.now)) {
      segment.endAt = options.now
      segment.end = 'current'
    }
    if (state === 'working' && (segment.end === 'unknown' || segment.end === 'observation-gap')) coverage.gaps = true
    segments.push(segment)
  }
  return { segments, coverage }
}

/** Existing work-only contract delegates pairing to the same activity owner. */
export function projectAgentWorkHistory(items: readonly AgentTimelineItem[], options: Parameters<typeof projectAgentActivityHistory>[1] = {}): AgentWorkHistoryProjection {
  const result = projectAgentActivityHistory(items, options)
  return { coverage: result.coverage, segments: result.segments.filter(segment => segment.state === 'working')
    .map(({ state: _state, observationId: _id, detail: _detail, ...segment }) => segment) }
}
