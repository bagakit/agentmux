import type { AgentMuxAgentSession } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { LocalAttachment } from '../platform/native/device'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileFileUpload } from './attachments'

type Ref<T> = { current: T }
export type SelectionTarget = { runtimeId: string; hostId: string; sessionId: string; runId: string; recordId: string | null }
export type SelectionOperation = { id: number; kind: 'picker' | 'read'; label: string; target: SelectionTarget; cancelled: boolean; expanded: boolean;
  controller: AbortController; allowUpdate(): void; stopped: Promise<void>; stop(): void }
export type AttachmentFlight = { client: AgentMuxHostedClient | null; recordId: string | null; intent: string; claimedForSend: boolean;
  saved: boolean; dispatched: 'upload' | 'inspect' | null; cancelled: boolean; original: MobileFileUpload; stop(): void; stopped: Promise<null>; result: Promise<MobileFileUpload | null> }
export type AttachmentPageOwner = {
  revision: number
  uploads: Ref<MobileFileUpload[]>; recordIds: Ref<Map<string, string | null>>; originalEntries: Ref<Map<string, MobileFileUpload>>
  bytes: Ref<Map<string, LocalAttachment>>; exports: Ref<Map<string, { file: LocalAttachment; url: string }>>; busy: Ref<Map<string, AttachmentFlight>>
  pickerOpen: Ref<SelectionOperation | null>; selectionTail: Ref<Promise<void>>; selections: Ref<Map<number, SelectionOperation>>; nextSelection: Ref<number>
  current: Ref<{ client: AgentMuxHostedClient | null; session: AgentMuxAgentSession | null; connected: boolean; promptOperationId: string | null }>
  subscribe(listener: () => void): () => void; changed(): void; issue(): string | null
}
/** One document-local owner; unmounting a presentation does not discard its original bytes or continuations. */
export function createAttachmentPageOwner(onChange: () => void = () => {}): AttachmentPageOwner {
  const workface = getDeviceWorkface(), original = workface.snapshot().record.fileUploads ?? [], listeners = new Set<() => void>()
  const owner: AttachmentPageOwner = {
    revision: 0,
    uploads: { current: original.map(item => item.phase === 'sending' ? { ...item, phase: 'unknown', issue: '原上传回执尚未确认；核对同一操作，不会自动重传。' } : item) },
    recordIds: { current: new Map(original.map(item => [item.identity.operationId, workface.recordIdentity()])) },
    originalEntries: { current: new Map(original.map(item => [item.identity.operationId, item])) }, bytes: { current: new Map() }, exports: { current: new Map() }, busy: { current: new Map() },
    pickerOpen: { current: null }, selectionTail: { current: Promise.resolve() }, selections: { current: new Map() }, nextSelection: { current: 0 },
    current: { current: { client: null, session: null, connected: false, promptOperationId: null } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    changed() { owner.revision++; onChange(); for (const listener of listeners) listener() },
    issue() {
      const pending = owner.selections.current.values().next().value as SelectionOperation | undefined
      if (pending) return `原 Session ${pending.target.sessionId} 的附件仍在选择或读取；返回原对话结束该次等待，或等待完成后再更新。`
      const flight = owner.busy.current.values().next().value as AttachmentFlight | undefined
      if (flight) return `原附件操作仍在进行；返回原 Host ${flight.original.identity.hostId} 的 Session ${flight.original.identity.agentSessionId} 处理后再更新网页。`
      if (owner.bytes.current.size) {
        const original = owner.uploads.current.find(upload => owner.bytes.current.has(upload.identity.operationId))
        return original ? `所选附件仅保存在当前页面；请返回原 Host ${original.identity.hostId} 的 Session ${original.identity.agentSessionId}，上传或移除后再更新网页。`
          : '所选附件仅保存在当前页面；请先上传并加入消息，或移除附件，再更新网页。'
      }
      return null
    }
  }
  return owner
}
