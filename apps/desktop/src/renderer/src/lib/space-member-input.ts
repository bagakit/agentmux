import type { AgentPromptInputBinding } from '@agentmux/core'
import { validateAgentPromptInputBinding } from '@agentmux/core/prompt-condition'
import type { SpaceMountMemberTarget } from '../../../shared/space-mount'
import { configValuesEqual } from '../../../shared/config-edit'
import { mountedSpaceInputs, mountedSpaceTarget } from './space-mount-view'

export type MountedMemberInput = { target: SpaceMountMemberTarget; request: { operationId: string; prompt: string; binding: AgentPromptInputBinding }; submitted: boolean; response?: unknown; issue?: string | undefined }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const text = (v: unknown): v is string => typeof v === 'string' && !!v && !v.includes('\0')
/** Source-qualified member identity, retaining all original Run attempts rather than choosing the latest. */
export const mountedMemberInputScope = (v: SpaceMountMemberTarget) => JSON.stringify([v.hostId, v.target.reference.runtimeId, v.target.reference.spaceId, v.target.regionId, v.target.runtimeId, v.target.agentSessionId])
const EMPTY_REQUESTS: Record<string, unknown> = Object.freeze({})
export const mountedMemberIdentity = (v: SpaceMountMemberTarget) => JSON.stringify([v.target.reference.runtimeId,v.target.reference.spaceId,v.target.regionId,v.target.runtimeId,v.target.agentSessionId])
const unavailable = (): never => { throw Error('Saved member input is unreadable. Its original data is kept; the terminal remains a separate original reader.') }
export function mountedMemberRequestBuckets(value: unknown, mountKey: string, target: SpaceMountMemberTarget): Record<string, unknown> {
  const entries = mountedSpaceInputs(value), mount = entries[mountKey], original = mountedSpaceTarget(value, mountKey)
  if (!original || !object(mount) || original.reference.runtimeId !== target.target.reference.runtimeId || original.reference.spaceId !== target.target.reference.spaceId) return unavailable()
  if (mount.memberInputs === undefined) return EMPTY_REQUESTS
  return object(mount.memberInputs) ? mount.memberInputs : unavailable()
}
export function mountedMemberRequests(value: unknown, mountKey: string, target: SpaceMountMemberTarget): Record<string, unknown> {
  const input = mountedMemberRequestBuckets(value,mountKey,target)[mountedMemberInputScope(target)]
  return input === undefined ? EMPTY_REQUESTS : object(input) ? input : unavailable()
}
function readMountedMemberInput(value: unknown, operationId: string): MountedMemberInput {
  if (!object(value) || !object(value.target) || !object(value.target.target) || !object(value.target.target.reference) || !object(value.target.target.expectedRun) ||
    ![value.target.hostId,value.target.target.reference.runtimeId,value.target.target.reference.spaceId,value.target.target.regionId,value.target.target.runtimeId,value.target.target.agentSessionId,value.target.target.expectedRun.runId].every(text) ||
    !object(value.request) || !text(operationId) || value.request.operationId !== operationId || typeof value.request.prompt !== 'string' || typeof value.submitted !== 'boolean' || value.issue !== undefined && typeof value.issue !== 'string') return unavailable()
  const input = value as MountedMemberInput
  const binding = validateAgentPromptInputBinding(input.request.binding)
  if (binding.expectedRun.runId !== input.target.target.expectedRun.runId) return unavailable()
  return input
}
export function mountedMemberInput(value: unknown, target: SpaceMountMemberTarget, operationId: string): MountedMemberInput {
  const input = readMountedMemberInput(value,operationId)
  if (mountedMemberIdentity(input.target) !== mountedMemberIdentity(target)) return unavailable()
  return input
}
/** Display one semantic member across retained carriers; every action keeps the frozen original target. */
export function mountedMemberMessages(buckets: Record<string,unknown>, target: SpaceMountMemberTarget): Array<{id:string;operationId?:string;input?:MountedMemberInput}> {
  const rows:Array<{id:string;operationId?:string;input?:MountedMemberInput}>=[]
  for(const [bucket,values] of Object.entries(buckets)) {
    if(!object(values)){if(bucket===mountedMemberInputScope(target))rows.push({id:JSON.stringify([bucket])});continue}
    for(const [operationId,value] of Object.entries(values)) {
      try { const input=readMountedMemberInput(value,operationId)
        if(mountedMemberIdentity(input.target)===mountedMemberIdentity(target))rows.push({id:JSON.stringify([bucket,operationId]),operationId,...(bucket===mountedMemberInputScope(input.target)?{input}:{})})
      }catch{if(bucket===mountedMemberInputScope(target))rows.push({id:JSON.stringify([bucket,operationId]),operationId})}
    }
  }
  return rows
}
/** Only one private intent changes. The optional window layout and all opaque neighbours are untouched. */
export function editMountedMemberInput(value: unknown, mountKey: string, target: SpaceMountMemberTarget, operationId: string,
  update: (current: MountedMemberInput | undefined) => MountedMemberInput): Record<string, unknown> {
  const entries = mountedSpaceInputs(value), mount = entries[mountKey]
  if (!object(mount)) return unavailable()
  const before = mountedMemberRequests(value,mountKey,target), current = before[operationId] === undefined ? undefined : mountedMemberInput(before[operationId],target,operationId), next = update(current)
  mountedMemberInput(next,target,operationId)
  if (mountedMemberInputScope(next.target) !== mountedMemberInputScope(target) || current && !sameMountedMemberInput(current,next)) return unavailable()
  if (next === current) return entries
  const all = mount.memberInputs as Record<string, unknown> | undefined
  return { ...entries, [mountKey]: { ...mount, memberInputs: { ...all, [mountedMemberInputScope(target)]: { ...before, [operationId]: next } } } }
}
export function sameMountedMemberInput(a: MountedMemberInput, b: MountedMemberInput) {
  return configValuesEqual(a.target,b.target) && configValuesEqual(a.request,b.request)
}

export function mountedMemberDraft(value: unknown, mountKey: string, tabId: string, target: SpaceMountMemberTarget): string {
  const entries = mountedSpaceInputs(value), mount = entries[mountKey]
  // Checking the original locator is independent of an optional private layout.
  const original = mountedSpaceTarget(value,mountKey)
  if (!original || original.reference.runtimeId !== target.target.reference.runtimeId || original.reference.spaceId !== target.target.reference.spaceId) return unavailable()
  if (!object(mount) || !object(mount.drafts)) return unavailable()
  const key = JSON.stringify([target.target.reference.runtimeId,target.target.reference.spaceId,tabId,target.target.regionId])
  const draft = mount.drafts[key]
  if (draft === undefined) return ''
  return typeof draft === 'string' ? draft : unavailable()
}
