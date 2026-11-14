import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxNameActor } from './display-label.js'

export const BROWSER_PROFILE_CREATION_OPERATIONS = ['browser.profile.create', 'browser.profile.copy',
  'browser.profile.folder.create', 'browser.profile.view.create', 'browser.profile.proxy.create'] as const
export type BrowserProfileCreationOperation = typeof BROWSER_PROFILE_CREATION_OPERATIONS[number]
export type BrowserProfileCreationActor = AgentMuxNameActor & { kind: 'agent' | 'user' | 'device'; id: string; verified: true; hostId?: string }
export type BrowserProfileCreationReceipt = {
  operationId: string; actor: BrowserProfileCreationActor; action: BrowserProfileCreationOperation;
  requestDigest: string; createdId: string; createdKind: 'profile' | 'folder' | 'view' | 'proxy'; committedAt: number;
  source?: { profileId: string; expectedRevision: string }; expectedCollectionRevision?: number
}
export type BrowserProfileCreationInspection = {
  operationId: string; receipt: BrowserProfileCreationReceipt | null;
  current: { state: 'present' | 'archived' | 'removed' | 'unknown'; createdId?: string };
  /** A read can observe a committed producer record, but cannot prove its original directory ACK. */
  durability: 'confirmed' | 'unconfirmed'
}
export function isBrowserProfileCreationOperation(value: unknown): value is BrowserProfileCreationOperation {
  return (BROWSER_PROFILE_CREATION_OPERATIONS as readonly unknown[]).includes(value)
}
export function browserProfileCreationActor(actor: AgentMuxNameActor | undefined): BrowserProfileCreationActor {
  if (!actor?.verified || !actor.id || !['agent', 'user', 'device'].includes(actor.kind))
    throw new AgentMuxError('Profile creation requires its original authenticated actor. Existing Profiles and Browsers remain available.', 'CONTROL_PERMISSION_DENIED')
  const hostId = (actor as BrowserProfileCreationActor).hostId
  if (hostId !== undefined && (typeof hostId !== 'string' || !hostId || /[\u0000-\u001f\u007f]/u.test(hostId))) throw new AgentMuxError('The original Profile creation Host scope is invalid.', 'CONTROL_PERMISSION_DENIED')
  return { kind: actor.kind as BrowserProfileCreationActor['kind'], id: actor.id, verified: true, ...(hostId === undefined ? {} : { hostId }) }
}
export function browserProfileCreationOperationId(value: unknown, code = 'INVALID_CONTROL_REQUEST'): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new AgentMuxError('Keep an explicit original Profile creation operationId.', code)
  return value
}
export function browserProfileCreationCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(browserProfileCreationCanonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + browserProfileCreationCanonical(v)).join(',') + '}'
  return JSON.stringify(value)
}
export function parseBrowserProfileCreationReceipt(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): BrowserProfileCreationReceipt {
  const p = rpcRecord(value, ['operationId','actor','action','requestDigest','createdId','createdKind','committedAt','source','expectedCollectionRevision'], code)
  const fail = () => { throw new AgentMuxError('The original Profile creation receipt is invalid.', code) }
  const operationId = browserProfileCreationOperationId(p.operationId, code)
  const actor = rpcRecord(p.actor, ['kind','id','verified','hostId'], code)
  if (actor.hostId !== undefined && (typeof actor.hostId !== 'string' || !actor.hostId)) fail()
  if (!isBrowserProfileCreationOperation(p.action) || !['profile','folder','view','proxy'].includes(p.createdKind as string) ||
    typeof p.createdId !== 'string' || !p.createdId || typeof p.requestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.requestDigest) ||
    !Number.isSafeInteger(p.committedAt) || (p.committedAt as number) < 0 || actor.verified !== true ||
    !['agent','user','device'].includes(actor.kind as string) || typeof actor.id !== 'string' || !actor.id) fail()
  if (p.expectedCollectionRevision !== undefined && (!Number.isSafeInteger(p.expectedCollectionRevision) || (p.expectedCollectionRevision as number) < 0)) fail()
  if (p.source !== undefined) {
    const source = rpcRecord(p.source, ['profileId','expectedRevision'], code)
    if (typeof source.profileId !== 'string' || !source.profileId || typeof source.expectedRevision !== 'string' || !source.expectedRevision) fail()
  }
  if ((p.action === 'browser.profile.copy') !== (p.source !== undefined) ||
    (p.action === 'browser.profile.folder.create' || p.action === 'browser.profile.view.create') !== (p.expectedCollectionRevision !== undefined)) fail()
  const expectedKind = p.action === 'browser.profile.create' || p.action === 'browser.profile.copy' ? 'profile' : String(p.action).split('.')[2]
  if (p.createdKind !== expectedKind) fail()
  return { ...p, operationId } as BrowserProfileCreationReceipt
}
export function parseBrowserProfileCreationInspection(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): BrowserProfileCreationInspection {
  const p = rpcRecord(value, ['operationId','receipt','current','durability'], code)
  const operationId = browserProfileCreationOperationId(p.operationId)
  const receipt = p.receipt === null ? null : parseBrowserProfileCreationReceipt(p.receipt, code)
  const current = rpcRecord(p.current, ['state','createdId'], code)
  if (!['present','archived','removed','unknown'].includes(current.state as string) || !['confirmed','unconfirmed'].includes(p.durability as string) ||
    receipt && (receipt.operationId !== operationId || current.createdId !== receipt.createdId) ||
    !receipt && (current.state !== 'unknown' || current.createdId !== undefined))
    throw new AgentMuxError('Profile creation observation names another original operation or identity.', code)
  return { operationId, receipt, current: current as BrowserProfileCreationInspection['current'], durability: p.durability as BrowserProfileCreationInspection['durability'] }
}
