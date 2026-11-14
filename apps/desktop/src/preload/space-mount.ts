import { unwrapSessionInputOperationResult } from '../shared/session-input-result'
import { mintObjectId } from '@agentmux/core/object-id'
import { SPACE_MOUNT_EVENT, SPACE_MOUNT_SESSIONS_EVENT, SPACE_MOUNT_MEMBER_EVENT, type SpaceMountPreloadApi, type SpaceMountMemberIdentity, type SpaceMountMemberEvent } from '../shared/space-mount'
import type { SessionInputOperationResult } from '../shared/contracts'

type Ipc = Pick<Electron.IpcRenderer, 'invoke' | 'on' | 'removeListener'>
type ReaderEvent = { type: string; error?: { code: string; message: string } }
/** Fixed messages and only this sender's cancellation; no arbitrary public RPC bridge. */
export function createPreloadSpaceMount(ipc: Ipc): SpaceMountPreloadApi {
  async function reader<I, E extends ReaderEvent>(channel: string, eventChannel: string, input: unknown, listener: (event: E) => void,
    context?: { onAbort?: (cancel: () => void) => () => void }, token = mintObjectId()): Promise<SessionInputOperationResult<{ initial: I; dispose(): void }>> {
     let closed = false, failure: Error | undefined, release: (() => void) | undefined
    const dispose = () => { if (closed) return; closed = true; release?.(); ipc.removeListener(eventChannel, receive); void ipc.invoke('spaceMounts:cancel', token).catch(() => {}) }
    const receive = (_event: unknown, value: { token: string; observation: E }) => {
      if (closed || value.token !== token) return
      listener(value.observation)
      if (value.observation.type === 'error' && value.observation.error) { failure = Object.assign(new Error(value.observation.error.message), value.observation.error); dispose() }
    }
    ipc.on(eventChannel, receive)
    const pending: Promise<SessionInputOperationResult<I>> = ipc.invoke(channel, token, input)
    release = context?.onAbort?.(dispose)
    if (closed) release?.()
    try { const result = await pending; if (!result.ok) { dispose(); return result }; if (closed) throw failure ?? new Error('The original Space reader closed before its opening was adopted.'); return { ok: true, value: { initial: result.value, dispose } } }
    catch (error) { dispose(); throw error }
  }
  return {
    member: async (input, listener, context) => {
      const memberToken = mintObjectId()
      const result = await reader<SpaceMountMemberIdentity, SpaceMountMemberEvent>('spaceMounts:member', SPACE_MOUNT_MEMBER_EVENT, input, listener, context, memberToken)
      if (!result.ok) return result
      return { ok: true, value: { ...result.value, call: async (method, value, signal) => {
        signal?.throwIfAborted(); const token = mintObjectId(), cancel = () => { void ipc.invoke('spaceMounts:cancel', token).catch(() => {}) }
        signal?.addEventListener('abort', cancel, { once: true })
        try { const reply = await ipc.invoke('spaceMounts:memberCall', token, memberToken, method, value); signal?.throwIfAborted(); return unwrapSessionInputOperationResult(reply) }
        finally { signal?.removeEventListener('abort', cancel) }
      } } }
    },
    call: async (method, input, context) => {
      const token = mintObjectId(), pending = ipc.invoke('spaceMounts:call', token, method, input)
      const release = context?.onAbort?.(() => { void ipc.invoke('spaceMounts:cancel', token).catch(() => {}) })
      try { return await pending } finally { release?.() }
    },
    watch: (input, listener, context) => reader('spaceMounts:watch', SPACE_MOUNT_EVENT, input, listener, context),
    sessions: (input, listener, context) => reader('spaceMounts:sessions', SPACE_MOUNT_SESSIONS_EVENT, input, listener, context)
  }
}
