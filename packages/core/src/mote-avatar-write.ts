import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseMoteAvatarSeriesDefinition, parseMoteAvatarSeriesLocator, parseMoteAvatarSeriesParameters,
  isMoteAvatarSeriesChoice, type MoteAvatarSeriesChoice, type MoteAvatarSeriesDefinition, type MoteAvatarSeriesParameters, type MoteAvatarSeriesSource,
  type MoteAvatarSeriesMethod, type MoteAvatarSeriesParameterMap, type MoteAvatarSeriesResultMap } from './mote-avatar-series.js'

/** Exact original content identity. Presentation/focus never supplies authority. */
export type MoteAvatarTarget = { workspaceId: string; topicId: string; objectKey: string }
export type MoteAvatarSave = {
  target: MoteAvatarTarget; operationId: string; beforeRevision: string;
  source: MoteAvatarSeriesSource; definition: MoteAvatarSeriesDefinition;
  parameters: MoteAvatarSeriesParameters; pngDataUrl: string
}
export type MoteAvatarOperation = {
  operationId: string; requestHash: string;
  phase: 'intent' | 'asset' | 'publication-unknown' | 'published';
  durability: 'unknown' | 'confirmed';
  choice?: MoteAvatarSeriesChoice; issue?: string
}
export type MoteAvatarRead = {
  target: MoteAvatarTarget; revision: string;
  /** Original authored data, including unsupported records; never silently discarded. */
  choice: unknown;
  image?: { dataUrl: string; width: number; height: number };
  source?: { state: 'available' | 'unavailable' | 'changed'; issue?: string };
  operation?: MoteAvatarOperation; issues: string[]
}
export type MoteAvatarSaveResult = { state: 'refused' | 'saved' | 'unknown'; operation?: MoteAvatarOperation; issue?: string; current: MoteAvatarRead }
export type MoteAvatarWriteParameterMap = {
  'space.mote.avatar.read': {target:MoteAvatarTarget;operationId?:string};
  'space.mote.avatar.save': MoteAvatarSave
}
export type MoteAvatarWriteResultMap = {
  'space.mote.avatar.read': MoteAvatarRead;
  'space.mote.avatar.save': MoteAvatarSaveResult
}
export type MoteAvatarWriteMethod = keyof MoteAvatarWriteParameterMap
export type MoteAvatarMethod = MoteAvatarSeriesMethod | MoteAvatarWriteMethod
export type MoteAvatarParameterMap = MoteAvatarSeriesParameterMap & MoteAvatarWriteParameterMap
export type MoteAvatarResultMap = MoteAvatarSeriesResultMap & MoteAvatarWriteResultMap
export interface AgentMuxRpcMoteAvatarsOwner {
  call<M extends MoteAvatarMethod>(method:M,params:MoteAvatarParameterMap[M]):Promise<MoteAvatarResultMap[M]>
}
export const AGENTMUX_RPC_MOTE_AVATAR_WRITE_METHODS = {'space.mote.avatar.read':'long','space.mote.avatar.save':'long'} as const
export function isMoteAvatarWriteMethod(value:unknown):value is MoteAvatarWriteMethod {
  return typeof value==='string' && Object.hasOwn(AGENTMUX_RPC_MOTE_AVATAR_WRITE_METHODS,value)
}

function fail(message: string, code: string): never { throw new AgentMuxError(message, code) }
function revision(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail('An exact saved appearance revision is required.', code)
}
export function parseMoteAvatarTarget(raw: unknown, code = 'INVALID_CONTROL_REQUEST'): MoteAvatarTarget {
  const target = rpcRecord(raw, ['workspaceId','topicId','objectKey'], code)
  for (const key of ['workspaceId','topicId','objectKey']) if (typeof target[key] !== 'string' || !target[key] || (target[key] as string).length > 4096 || /[\0\r\n]/u.test(target[key] as string)) fail('An exact original Mote target is required.', code)
  return target as MoteAvatarTarget
}
export function parseMoteAvatarOperationId(value: unknown, code = 'INVALID_CONTROL_REQUEST'): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value)) fail('Keep the original UUID operationId when inspecting or retrying this save.', code)
}
export function parseMoteAvatarSave(raw: unknown, code = 'INVALID_CONTROL_REQUEST'): MoteAvatarSave {
  const p = rpcRecord(raw, ['target','operationId','beforeRevision','source','definition','parameters','pngDataUrl'], code)
  parseMoteAvatarTarget(p.target, code); parseMoteAvatarOperationId(p.operationId, code); revision(p.beforeRevision, code)
  parseMoteAvatarSeriesLocator(p.source, code, true)
  const definition = parseMoteAvatarSeriesDefinition(p.definition, code)
  parseMoteAvatarSeriesParameters(p.parameters, definition, code)
  if (typeof p.pngDataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(p.pngDataUrl) || p.pngDataUrl.length > Math.ceil(512 * 1024 / 3) * 4 + 22 || (p.pngDataUrl.length - 22) % 4) fail('Supply the exact bounded PNG from the selected avatar frame.', code)
  return p as MoteAvatarSave
}
export function parseMoteAvatarWriteParams<M extends MoteAvatarWriteMethod>(method:M,raw:unknown,code='INVALID_CONTROL_REQUEST'):MoteAvatarWriteParameterMap[M] {
  if (method==='space.mote.avatar.save') return parseMoteAvatarSave(raw,code) as MoteAvatarWriteParameterMap[M]
  const p=rpcRecord(raw,['target','operationId'],code);parseMoteAvatarTarget(p.target,code)
  if (p.operationId!==undefined) parseMoteAvatarOperationId(p.operationId,code)
  return p as MoteAvatarWriteParameterMap[M]
}
function operation(raw:unknown,operationId:string|undefined,code:string):MoteAvatarOperation {
  const p=rpcRecord(raw,['operationId','requestHash','phase','durability','choice','issue'],code)
  parseMoteAvatarOperationId(p.operationId,code);revision(p.requestHash,code)
  if (operationId!==undefined && p.operationId!==operationId) fail('The receipt belongs to a different original operation.',code)
  if (!['intent','asset','publication-unknown','published'].includes(p.phase as string) || !['unknown','confirmed'].includes(p.durability as string) || p.durability==='confirmed' && p.phase!=='published') fail('The avatar operation contains an unsupported outcome.',code)
  if (p.phase!=='intent' && !isMoteAvatarSeriesChoice(p.choice)) fail('The avatar operation lost its exact saved choice.',code)
  if (p.issue!==undefined && (typeof p.issue!=='string' || p.issue.length>4096)) fail('The avatar operation issue is invalid.',code)
  return p as MoteAvatarOperation
}
function readResult(raw:unknown,target:MoteAvatarTarget,operationId:string|undefined,code:string):MoteAvatarRead {
  const p=rpcRecord(raw,['target','revision','choice','image','source','operation','issues'],code)
  const actual=parseMoteAvatarTarget(p.target,code)
  if (actual.workspaceId!==target.workspaceId || actual.topicId!==target.topicId || actual.objectKey!==target.objectKey) fail('The saved appearance belongs to a different original Mote.',code)
  revision(p.revision,code)
  if (!Object.hasOwn(p,'choice') || !Array.isArray(p.issues) || p.issues.some(issue=>typeof issue!=='string' || issue.length>4096)) fail('The original appearance read is incomplete.',code)
  if (p.image!==undefined) {
    const image=rpcRecord(p.image,['dataUrl','width','height'],code)
    if (image.width!==256 || image.height!==256 || typeof image.dataUrl!=='string' || image.dataUrl.length>Math.ceil(512*1024/3)*4+22 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(image.dataUrl)) fail('The original saved PNG is invalid.',code)
  }
  if (p.source!==undefined) {
    const source=rpcRecord(p.source,['state','issue'],code)
    if (!['available','unavailable','changed'].includes(source.state as string) || source.issue!==undefined && typeof source.issue!=='string') fail('The saved source observation is invalid.',code)
  }
  if (p.operation!==undefined) operation(p.operation,operationId,code)
  return p as MoteAvatarRead
}
export function parseMoteAvatarWriteResult<M extends MoteAvatarWriteMethod>(method:M,raw:unknown,input:MoteAvatarWriteParameterMap[M],code='CONTROL_PROTOCOL_ERROR'):MoteAvatarWriteResultMap[M] {
  if (method==='space.mote.avatar.read') return readResult(raw,input.target,input.operationId,code) as MoteAvatarWriteResultMap[M]
  const p=rpcRecord(raw,['state','operation','issue','current'],code)
  if (!['refused','saved','unknown'].includes(p.state as string)) fail('The avatar save outcome is invalid.',code)
  const op=p.operation===undefined?undefined:operation(p.operation,input.operationId,code)
  if (p.state==='saved' && (op?.phase!=='published' || op.durability!=='confirmed')) fail('Saved requires an acknowledged original publication.',code)
  if (p.issue!==undefined && typeof p.issue!=='string') fail('The avatar save issue is invalid.',code)
  readResult(p.current,input.target,input.operationId,code)
  return p as MoteAvatarWriteResultMap[M]
}
