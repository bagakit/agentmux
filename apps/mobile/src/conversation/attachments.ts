import { parseFileUploadIdentity, parseFileUploadResult, type FileUploadIdentity, type FileUploadResult } from '@agentmux/core/files'
import { parseComposerDraft } from '@agentmux/client-ui/composer-semantic-reference'

/** Device-owned upload intent. File bytes are retained only by the current OS selection or original Host. */
export type MobileFileUpload = { runtimeId: string; identity: FileUploadIdentity;
  phase: 'selected' | 'sending' | 'unknown' | 'uploaded' | 'inserted' | 'error'; path?: string; issue?: string }
export type ConfirmedAttachmentPrompt = { operationId: string; body: string;
  source: { runtimeId: string; hostId: string; sessionId: string; runId: string } }
/** Compare the complete original upload intent, never a display name or current occurrence. */
export function fileUploadIntentKey(upload: MobileFileUpload): string {
  const value = upload.identity
  return JSON.stringify([upload.runtimeId, value.hostId, value.agentSessionId, value.expectedRun.runId,
    value.operationId, value.name, value.mimeType, value.byteLength, value.revision])
}
/** Only the frozen authored draft codec can establish whether this exact reference was included. */
export function draftIncludesUpload(body: string, path: string): boolean {
  return parseComposerDraft(body).some(part => 'reference' in part && part.reference.kind === 'file' && part.reference.reference === '@' + path)
}
export function parseMobileFileUpload(value: unknown): MobileFileUpload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原附件记录无法核实；不会上传或替换它。')
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !['runtimeId', 'identity', 'phase', 'path', 'issue'].includes(key)) ||
      typeof p.runtimeId !== 'string' || !p.runtimeId.length || p.runtimeId.length > 256 ||
      !['selected', 'sending', 'unknown', 'uploaded', 'inserted', 'error'].includes(String(p.phase)) ||
      p.issue !== undefined && (typeof p.issue !== 'string' || p.issue.length > 8192)) throw new Error('原附件记录无法核实；原工作面保留。')
  const identity = parseFileUploadIdentity(p.identity)
  if (p.phase === 'uploaded' || p.phase === 'inserted') parseFileUploadResult({ ...identity, status: 'uploaded', path: p.path }, identity)
  else if (p.path !== undefined) throw new Error('附件路径尚未取得原 Host 确认。')
  return structuredClone(p) as MobileFileUpload
}
export function fileUploadScopeMatches(upload: MobileFileUpload, scope: {
  runtimeId: string | null; hostId: string | null; sessionId: string | null; runId: string | null
}): boolean {
  return upload.runtimeId === scope.runtimeId && upload.identity.hostId === scope.hostId &&
    upload.identity.agentSessionId === scope.sessionId && upload.identity.expectedRun.runId === scope.runId
}
export function uploadFromReceipt(original: MobileFileUpload, value: FileUploadResult): MobileFileUpload {
  const result = parseFileUploadResult(value, original.identity)
  if (result.status === 'uploaded') return { runtimeId: original.runtimeId, identity: original.identity, phase: 'uploaded', path: result.path }
  return { runtimeId: original.runtimeId, identity: original.identity, phase: result.status === 'error' ? 'error' : 'unknown',
    issue: result.status === 'missing' ? '原 Host 未找到这次上传记录；本次没有重传。原文件和草稿仍保留。' : `${result.message} [${result.code}]` }
}
