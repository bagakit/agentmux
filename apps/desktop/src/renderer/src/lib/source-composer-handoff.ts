import { validateAgentPromptInputBinding } from '@agentmux/core/prompt-condition'
import { parseAgentInputSubmissionReceipt } from '@agentmux/core/agent-input-receipt'
import { parseSpaceMemberTarget } from '@agentmux/core/space-member-codec'
import type { SpaceMountMemberTarget } from '../../../shared/space-mount'
import { spaceMountKey } from '../../../shared/space-mount'
import { configValuesEqual } from '../../../shared/config-edit'
import type { AgentSteerQueueEntry } from '../store'
import { originalSourceInputOwnerKey } from './original-space-navigation'
import { projectInputReceipt } from '@agentmux/client-ui/input-receipt-projection'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value))
type FrozenInput = { target: SpaceMountMemberTarget; request: { operationId: string; prompt: string;
  binding: NonNullable<AgentSteerQueueEntry['directInputBinding']> }; submitted: boolean; response?: unknown; issue?: string }
export type SourceInputRecoveryRow = { path: string[]; raw: unknown; text?: string; issue: string; input?: FrozenInput }
type HandoffState = { mountedSpaceInputs: unknown; agentSteerQueues: Record<string, AgentSteerQueueEntry[]> }
const sameMember = (a: SpaceMountMemberTarget, b: SpaceMountMemberTarget) => a.target.reference.runtimeId === b.target.reference.runtimeId &&
  a.target.reference.spaceId === b.target.reference.spaceId && a.target.regionId === b.target.regionId &&
  a.target.runtimeId === b.target.runtimeId && a.target.agentSessionId === b.target.agentSessionId

/** Read-only recovery of the old document. A current Region never supplies a missing historical identity. */
export function sourceInputRecoveryRows(value: unknown, target: SpaceMountMemberTarget, tabId?: string): SourceInputRecoveryRow[] {
  if (value === undefined) return []
  if (!record(value)) return [{ path: [], raw: value, issue: 'The saved Source input document is unreadable. Its original bytes are available to copy.' }]
  const key = spaceMountKey(target.target.reference), entry = value[key]
  if (entry === undefined) return []
  if (!record(entry)) return [{ path: [key], raw: entry, issue: 'Saved Source input is unreadable. Its original bytes are kept.' }]
  const rows: SourceInputRecoveryRow[] = []
  if (entry.drafts !== undefined && !record(entry.drafts)) rows.push({ path: [key, 'drafts'], raw: entry.drafts, issue: 'Saved workface drafts are unreadable.' })
  else if (record(entry.drafts)) for (const [draftKey, raw] of Object.entries(entry.drafts)) {
    let address: unknown
    try { address = JSON.parse(draftKey) } catch { address = undefined }
    if (Array.isArray(address) && (address.length === 4 || address.length === 5) && (address[0] !== target.target.reference.runtimeId || address[1] !== target.target.reference.spaceId ||
        address.at(-1) !== target.target.regionId || tabId !== undefined && address.at(-2) !== tabId)) continue
    rows.push({ path: [key, 'drafts', draftKey], raw, ...(typeof raw === 'string' ? { text: raw } : {}),
      issue: 'This saved workface draft has no original Agent identity. Choose explicitly before filling the current draft.' })
  }
  if (entry.memberInputs === undefined) return rows
  if (!record(entry.memberInputs)) return [...rows, { path: [key, 'memberInputs'], raw: entry.memberInputs, issue: 'Saved input requests are unreadable.' }]
  for (const [bucket, values] of Object.entries(entry.memberInputs)) {
    if (!record(values)) { rows.push({ path: [key, 'memberInputs', bucket], raw: values, issue: 'This saved request group is unreadable.' }); continue }
    for (const [operationId, raw] of Object.entries(values)) {
      const row: SourceInputRecoveryRow = { path: [key, 'memberInputs', bucket, operationId], raw,
        issue: 'This original request cannot be handed off automatically. Its bytes and unknown outcome are kept.' }
      try {
        if (!record(raw) || !record(raw.target) || typeof raw.target.hostId !== 'string' || !raw.target.hostId) throw Error()
        const member = { hostId: raw.target.hostId, target: parseSpaceMemberTarget(raw.target.target) }
        if (!sameMember(member, target)) continue
        if (record(raw.request) && typeof raw.request.prompt === 'string') row.text = raw.request.prompt
        if (bucket !== JSON.stringify([member.hostId, member.target.reference.runtimeId, member.target.reference.spaceId,
            member.target.regionId, member.target.runtimeId, member.target.agentSessionId]) ||
            Object.keys(raw).some(key => !['target', 'request', 'submitted', 'response', 'issue'].includes(key)) ||
            Object.keys(raw.target).some(key => !['hostId', 'target'].includes(key))) throw Error()
        if (!member.target.expectedAdmission || !record(raw.request) || raw.request.operationId !== operationId ||
            typeof raw.request.prompt !== 'string' || typeof raw.submitted !== 'boolean' ||
            raw.issue !== undefined && typeof raw.issue !== 'string') throw Error()
        if (Object.keys(raw.request).some(key => !['operationId', 'prompt', 'binding'].includes(key))) throw Error()
        const binding = validateAgentPromptInputBinding(raw.request.binding)
        if (!('admissionIntent' in binding) || binding.expectedRun.runId !== member.target.expectedRun.runId) throw Error()
        // Preserve the exact original carrier, request and result. Current access never fills old C/L.
        row.input = { target: member, request: { operationId, prompt: raw.request.prompt, binding }, submitted: raw.submitted,
          ...(Object.hasOwn(raw, 'response') ? { response: raw.response } : {}), ...(typeof raw.issue === 'string' ? { issue: raw.issue } : {}) }
        if (Object.hasOwn(raw, 'response')) {
          const receipt = parseAgentInputSubmissionReceipt(raw.response)
          if (receipt.key.kind !== 'prompt' || receipt.key.agentSessionId !== member.target.agentSessionId ||
              receipt.key.expectedRun.runId !== member.target.expectedRun.runId || receipt.key.submissionId !== operationId ||
              receipt.admission?.admission?.intent && receipt.admission.admission.intent.prompt !== raw.request.prompt) throw Error()
        }
      } catch { delete row.input }
      rows.push(row)
    }
  }
  return rows
}

function inputEntry(row: SourceInputRecoveryRow): AgentSteerQueueEntry | undefined {
  const input = row.input
  if (!input) return
  const receipt = Object.hasOwn(input, 'response') ? parseAgentInputSubmissionReceipt(input.response) : undefined
  return { operationId: input.request.operationId, text: input.request.prompt, promptCondition: null,
    runId: input.target.target.expectedRun.runId, directInputBinding: input.request.binding, originalMember: structuredClone(input.target),
    status: 'deferred', awaitingExplicitSend: true, ...(input.submitted || receipt ? { inputIntakeStarted: true } : {}),
    ...(receipt ? { inputReceipt: structuredClone(receipt),
      ...(['admitted', 'terminal-confirmed', 'launch-carried'].includes(receipt.status) ? { archived: true as const } : {}) } : {}),
    ...(input.issue === undefined ? {} : { error: input.issue }), recoveredSourceInput: structuredClone(row.raw) }
}
function sameIntent(a: AgentSteerQueueEntry, b: AgentSteerQueueEntry): boolean {
  return a.operationId === b.operationId && a.text === b.text && a.runId === b.runId &&
    configValuesEqual(a.directInputBinding, b.directInputBinding) && configValuesEqual(a.originalMember, b.originalMember)
}
/** Canonical copy only. No enqueue, fresh input authority, time, control, or queue drain is created. */
export function copySourceComposerInputs(state: HandoffState, rows: SourceInputRecoveryRow[]): Partial<HandoffState> {
  let queues = state.agentSteerQueues
  for (const row of rows) {
    const candidate = inputEntry(row)
    if (!candidate?.originalMember) continue
    const owner = originalSourceInputOwnerKey(candidate.originalMember.target.runtimeId, candidate.originalMember.target.agentSessionId)
    const queue = queues[owner] ?? [], existing = queue.find(item => item.operationId === candidate.operationId)
    if (existing && !sameIntent(existing, candidate)) continue
    if (existing?.recoveredSourceInput !== undefined && !configValuesEqual(existing.recoveredSourceInput, row.raw)) continue
    let merged = candidate
    if (existing) {
      let receipt = existing.inputReceipt
      try { if (candidate.inputReceipt) receipt = projectInputReceipt(receipt, candidate.inputReceipt) } catch { continue }
      merged = { ...existing, awaitingExplicitSend: true, recoveredSourceInput: candidate.recoveredSourceInput,
        ...(existing.inputIntakeStarted || candidate.inputIntakeStarted || receipt ? { inputIntakeStarted: true } : {}),
        ...(receipt ? { inputReceipt: receipt,
          ...(['admitted', 'terminal-confirmed', 'launch-carried'].includes(receipt.status) ? { archived: true as const } : {}) } : {}) }
      if (configValuesEqual(existing, merged)) continue
    }
    queues = { ...queues, [owner]: existing ? queue.map(item => item === existing ? merged : item) : [...queue, merged] }
  }
  return queues === state.agentSteerQueues ? {} : { agentSteerQueues: queues }
}
/** Called only after the canonical copy's original document checkpoint. Changed bytes stay recoverable. */
export function pruneSourceComposerInputs(state: HandoffState, rows: SourceInputRecoveryRow[]): Partial<HandoffState> {
  if (!record(state.mountedSpaceInputs)) return {}
  let root = state.mountedSpaceInputs
  for (const row of rows) {
    const candidate = inputEntry(row)
    if (!candidate?.originalMember) continue
    const owner = originalSourceInputOwnerKey(candidate.originalMember.target.runtimeId, candidate.originalMember.target.agentSessionId)
    const accepted = state.agentSteerQueues[owner]?.find(item => sameIntent(item, candidate) && configValuesEqual(item.recoveredSourceInput, row.raw))
    if (!accepted) continue
    if (candidate.inputIntakeStarted && !accepted.inputIntakeStarted) continue
    if (candidate.inputReceipt) {
      try { if (!accepted.inputReceipt || !configValuesEqual(projectInputReceipt(accepted.inputReceipt, candidate.inputReceipt), accepted.inputReceipt)) continue }
      catch { continue }
    }
    const [key, field, bucket, operationId] = row.path
    const entry = root[key!], requests = record(entry) ? entry[field!] : undefined, group = record(requests) ? requests[bucket!] : undefined
    if (!record(entry) || !record(requests) || !record(group) || !configValuesEqual(group[operationId!], row.raw)) continue
    const retainedGroup = { ...group }; delete retainedGroup[operationId!]
    const retainedRequests = { ...requests }
    if (Object.keys(retainedGroup).length) retainedRequests[bucket!] = retainedGroup
    else delete retainedRequests[bucket!]
    const retainedEntry = { ...entry }
    if (Object.keys(retainedRequests).length) retainedEntry[field!] = retainedRequests
    else delete retainedEntry[field!]
    root = { ...root, [key!]: retainedEntry }
  }
  return root === state.mountedSpaceInputs ? {} : { mountedSpaceInputs: root }
}
