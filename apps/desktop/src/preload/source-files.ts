import { mintObjectId } from '@agentmux/core/object-id'
import { parseFileMutationEffect, parseFileMutationWatchOpening } from '@agentmux/core/files'
import { SOURCE_FILES_EVENT, type SourceFilesEventFrame, type SourceFilesPreloadApi } from '../shared/source-files-client.js'
import type { SessionInputOperationResult } from '../shared/contracts.js'

type Ipc = Pick<Electron.IpcRenderer, 'invoke' | 'on' | 'removeListener'>
/** Only fixed Source Files calls and this frame's bounded observer acknowledgement. */
export function createPreloadSourceFiles(ipc: Ipc): SourceFilesPreloadApi {
  const call = async (channel: string, args: unknown[], cancellation?: Parameters<SourceFilesPreloadApi['resolve']>[2]) => {
    const token = mintObjectId(), pending = ipc.invoke(channel, token, ...args)
    const release = cancellation?.onAbort?.(() => { void ipc.invoke('sourceFiles:cancel', token).catch(() => {}) })
    try { return await pending } finally { release?.() }
  }
  return {
    resolve: (target, selection, cancellation) => call('sourceFiles:resolve', [target, selection], cancellation),
    call: (target, method, params, cancellation) => call('sourceFiles:call', [target, method, params], cancellation),
    watch: async (target, params, listener, cancellation) => {
      const token = mintObjectId()
      let closed = false, sequence = 0, failure: Error | undefined, release: (() => void) | undefined
      const dispose = () => { if (closed) return; closed = true; release?.(); ipc.removeListener(SOURCE_FILES_EVENT, receive); void ipc.invoke('sourceFiles:cancel', token).catch(() => {}) }
      const fail = (cause: unknown) => {
        if (closed) return
        failure = cause instanceof Error ? cause : new Error(String(cause)); dispose()
        try { void Promise.resolve(listener({ type: 'error', error: { code: 'FILE_MUTATION_OBSERVATION_UNAVAILABLE', message: failure.message } })).catch(() => {}) } catch { /* The original view is already detached. */ }
      }
      const receive = (_source: unknown, frame: SourceFilesEventFrame) => {
        if (closed || frame.token !== token) return
        if (!Number.isSafeInteger(frame.sequence) || frame.sequence !== sequence + 1) {
          fail(new Error('The original Files view has an observation gap. Its buffers and requests are retained.')); return
        }
        sequence = frame.sequence
        const event = frame.event
        try { if (event.type === 'effect') parseFileMutationEffect(event.data) }
        catch (cause) { fail(cause); return }
        void Promise.resolve().then(() => listener(event)).then(() => {
          if (event.type === 'effect' && !closed) return ipc.invoke('sourceFiles:ack', token, frame.sequence)
        }).catch(fail)
        if (event.type === 'error') { failure = Object.assign(new Error(event.error.message), { code: event.error.code }); dispose() }
        else if (event.type === 'end') dispose()
      }
      ipc.on(SOURCE_FILES_EVENT, receive)
      const pending: Promise<SessionInputOperationResult<import('@agentmux/core/files').FileMutationWatchOpening>> = ipc.invoke('sourceFiles:watch', token, target, params)
      release = cancellation?.onAbort?.(dispose)
      if (closed) release?.()
      try {
        const result = await pending
        if (!result.ok) { dispose(); return result }
        if (closed) throw failure ?? new Error('The original Files view closed before its observer opened.')
        const initial = parseFileMutationWatchOpening(result.value, params)
        return { ok: true, value: { initial, start: async () => { if (closed) throw failure ?? new Error('The original Files observer closed.'); await ipc.invoke('sourceFiles:ready', token) }, dispose } }
      } catch (cause) { dispose(); throw cause }
    }
  }
}
