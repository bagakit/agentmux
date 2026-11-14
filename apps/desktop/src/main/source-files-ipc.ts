import type { IpcMainInvokeEvent } from 'electron'
import { AgentMuxError, parseSpaceAuthorityRef, type AgentMuxRpcParams } from '@agentmux/core'
import { parseFileMutationWatchParams, type FileMutationWatchOpening } from '@agentmux/core/files'
import { parseFolderDirectoryInspectInput } from '@agentmux/core/space-folder'
import { SOURCE_FILES_METHODS, type SourceFilesMethod, type SourceFilesSelection } from '../shared/source-files.js'
import { SOURCE_FILES_EVENT, type SourceFilesEvent } from '../shared/source-files-client.js'
import { sessionInputOperationResult } from '../shared/session-input-result.js'
import { SessionHistoryReadOwners } from './session-history-read.js'
import { fields, sourceTarget } from './space-mount-ipc.js'
import type { RuntimeController } from './runtime-controller.js'

/** Fixed Source Files messages; no arbitrary RPC, event history or presentation authority. */
export function registerSourceFilesIpc(ports: {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  runtime: Pick<RuntimeController, 'resolveSourceFiles' | 'sourceFilesCall' | 'watchSourceFiles'>
}) {
  const reads = new SessionHistoryReadOwners()
  const frames = new Map<string, { sequence: number; busy: boolean; ready: boolean }>()
  const target = (value: unknown) => sourceTarget(fields(value, ['hostId', 'reference', 'expectedRuntimeId']))
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new AgentMuxError('The original Source file reference is required.', 'INVALID_CONTROL_REQUEST')
    return value
  }
  ports.handle('sourceFiles:resolve', (event, token: string, rawTarget: unknown, value: unknown) => sessionInputOperationResult(() => reads.read(event.sender, token, async signal => {
    const original = target(rawTarget), p = fields(value, ['kind', 'mount', 'path', 'registration', 'expectedResource'])
    const mount = (value: unknown) => {
      const m = fields(value, ['hostId', 'reference', 'zoneId', 'workspaceId'])
      return { hostId: text(m.hostId), reference: parseSpaceAuthorityRef(m.reference), zoneId: text(m.zoneId), workspaceId: text(m.workspaceId) }
    }
    let selection: SourceFilesSelection
    if (p.kind === 'mount' && p.path === undefined && p.registration === undefined && p.expectedResource === undefined) selection = { kind: 'mount', mount: mount(p.mount) }
    else if (p.kind === 'directory' && p.mount === undefined) {
      const observation = parseFolderDirectoryInspectInput({ runtimeId: 'reference' in original ? original.reference.runtimeId : original.expectedRuntimeId,
        path: p.path, ...(p.expectedResource === undefined ? {} : { expectedResource: p.expectedResource }) })
      selection = { kind: 'directory', path: observation.path, ...(observation.expectedResource ? { expectedResource: observation.expectedResource } : {}), ...(p.registration === undefined ? {} : { registration: mount(p.registration) }) }
    } else throw new AgentMuxError('Choose one original Source directory or mount.', 'INVALID_CONTROL_REQUEST')
    return await ports.runtime.resolveSourceFiles(original, selection, signal)
  })))
  ports.handle('sourceFiles:call', (event, token: string, rawTarget: unknown, method: unknown, value: unknown) => sessionInputOperationResult(async () => {
    if (typeof method !== 'string' || !(SOURCE_FILES_METHODS as readonly string[]).includes(method)) throw new AgentMuxError('Use a supported original Files operation.', 'INVALID_CONTROL_REQUEST')
    const original = target(rawTarget), params = structuredClone(fields(value, Object.keys(value && typeof value === 'object' ? value : {})))
    let obtained: Awaited<ReturnType<RuntimeController['sourceFilesCall']>> | undefined
    try { return await reads.read(event.sender, token, async signal => obtained = await ports.runtime.sourceFilesCall(original, method as SourceFilesMethod, params as AgentMuxRpcParams<SourceFilesMethod>, signal)) }
    catch (cause) { if (obtained) return obtained; throw cause } // Cancellation never discards a result already received from Core.
  }))
  ports.handle('sourceFiles:cancel', (event, token: string) => reads.cancel(event.sender.id, token))
  ports.handle('sourceFiles:ready', (event, token: string) => { const frame = frames.get(`${event.sender.id}:${token}`); if (frame) frame.ready = true })
  ports.handle('sourceFiles:ack', (event, token: string, sequence: number) => {
    const frame = frames.get(`${event.sender.id}:${token}`)
    if (frame && frame.sequence === sequence) frame.busy = false
  })
  ports.handle('sourceFiles:watch', (event, token: string, rawTarget: unknown, value: unknown) => sessionInputOperationResult(() => new Promise<FileMutationWatchOpening>((resolve, reject) => {
    const original = target(rawTarget), params = structuredClone(parseFileMutationWatchParams(value)), key = `${event.sender.id}:${token}`
    let opened = false, ended = false, finish: (() => void) | undefined
    const frame = { sequence: 0, busy: false, ready: false }
    void reads.read(event.sender, token, async signal => {
      const end = (error?: Error) => {
        if (ended) return
        ended = true
        try { if (opened && !event.sender.isDestroyed()) event.sender.send(SOURCE_FILES_EVENT, { token, sequence: ++frame.sequence,
          event: error ? { type: 'error', error: { code: (error as { code?: string }).code ?? 'FILE_MUTATION_OBSERVATION_UNAVAILABLE', message: error.message } } : { type: 'end', data: {} } }) }
        finally { finish?.(); reads.cancel(event.sender.id, token) }
      }
      let initial: FileMutationWatchOpening | undefined
      const deliver = (observation: SourceFilesEvent) => {
        if (ended || signal.aborted) return
        if (observation.type === 'error') { end(Object.assign(new Error(observation.error.message), { code: observation.error.code })); return }
        if (observation.type === 'end') { end(); return }
        if (!frame.ready) return
        if (frame.busy) { end(new AgentMuxError('The Files view could not consume its live observation. Its buffers and original requests are retained.', 'FILE_MUTATION_OBSERVATION_GAP')); return }
        frame.busy = true
        try {
          if (!event.sender.isDestroyed()) event.sender.send(SOURCE_FILES_EVENT, { token, sequence: ++frame.sequence, event: observation })
          else end(new Error('The original Files view closed.'))
        } catch (cause) { end(cause instanceof Error ? cause : new Error(String(cause))) }
      }
      const observed = await ports.runtime.watchSourceFiles(original, params, { signal, onInitial: value => { initial = value }, onEvent: deliver, onEnd: end })
      try {
        signal.throwIfAborted()
        if (!initial || ended) throw new Error('The original Files observer did not confirm its opening.')
        frames.set(key, frame); opened = true; resolve(initial)
        await new Promise<void>(done => { finish = () => done(); if (ended || signal.aborted) done(); else signal.addEventListener('abort', finish, { once: true }) })
      } finally { if (finish) signal.removeEventListener('abort', finish); frames.delete(key); await observed.dispose() }
    }).catch(error => { if (!opened) reject(error); else if (!ended && !event.sender.isDestroyed()) event.sender.send(SOURCE_FILES_EVENT, { token, sequence: ++frame.sequence,
      event: { type: 'error', error: { code: 'FILE_MUTATION_OBSERVATION_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } } }) })
  })))
  return { dispose: () => reads.dispose() }
}
