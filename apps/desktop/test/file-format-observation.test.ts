import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from '@agentmux/core/control'
import type { AgentMuxControlRequest } from '@agentmux/core'
import type { AgentMuxPreloadApi, DesktopControlCancellation, DesktopControlRequest, DesktopControlResponse } from '../src/shared/contracts'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api'
import { formatFileRegion, registerFileRegionFormatter } from '../src/renderer/src/lib/file-formats/format-file-region'
import { monacoFormatAdapter } from '../src/renderer/src/lib/file-formats/monaco-format-adapter'

// Only the engine is controlled: the production bridge, Renderer request owner,
// formatter controller and Monaco adapter all execute their real lifecycle.
class EngineWorker {
  static instances: EngineWorker[] = []
  onmessage!: (event: MessageEvent) => void
  onerror: unknown
  onmessageerror: unknown
  terminate = vi.fn()
  postMessage = vi.fn<(request: { id: string; path: string; content: string }) => void>()
  constructor() { EngineWorker.instances.push(this) }
  reply(content: string) {
    const request = this.postMessage.mock.calls[0]![0]
    this.onmessage({ data: { id: request.id, content } } as MessageEvent)
  }
}
const cleanups: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers(); EngineWorker.instances = []; vi.stubGlobal('Worker', EngineWorker) })
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

function fileRequest(requestId = 'format-observer'): Extract<AgentMuxControlRequest, { operation: 'file.format' }> {
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: 'file.format', regionId: 'original-file-region' }
}
function expectEndedObservation(error: unknown, code: 'CONTROL_TIMEOUT' | 'CONTROL_UNAVAILABLE') {
  expect(error).toMatchObject({ code, message: expect.stringContaining('Observation of file formatting has ended.') })
  expect((error as Error).message).toContain('accepted formatting may still finish in the original File Region')
  expect((error as Error).message).toContain('Inspect its current draft before deciding whether to retry.')
  expect((error as Error).message).not.toMatch(/formatting (?:failed|was cancelled)/i)
}

function liveEditor() {
  const document = { content: 'const x={a:1}', generation: 3, live: true }
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of [...listeners]) listener() }
  const subscribe = (listener: () => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } }
  const sequence: string[] = []
  const model = { isDisposed: () => false, getValue: () => document.content, getVersionId: () => document.generation,
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: document.content.length + 1 }), onDidChangeContent: subscribe }
  const editor = { getModel: () => model, onDidChangeModel: subscribe,
    pushUndoStop: vi.fn(() => { sequence.push('undoStop'); return true }),
    executeEdits: vi.fn((_source: string, edits: { text: string }[]) => {
      sequence.push('edit'); document.content = edits[0]!.text; document.generation++; changed(); return true
    }) }
  const adapter = monacoFormatAdapter(editor as any, { path: 'current.ts', isLive: () => document.live, read: () => document })
  const unregister = registerFileRegionFormatter('original-file-region', adapter)
  cleanups.push(unregister)
  return { document, editor, sequence, listeners, unregister, edit(content: string) { document.content = content; document.generation++; changed() } }
}

function connectedConsumer() {
  type Preload = AgentMuxPreloadApi['control']
  let requestListener!: Parameters<Preload['onRequest']>[0]
  let cancellationListener!: Parameters<Preload['onCancellation']>[0]
  const sent: DesktopControlRequest[] = [], cancellations: DesktopControlCancellation[] = []
  const responses: { response: DesktopControlResponse; accepted: boolean }[] = [], signals: AbortSignal[] = []
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true,
    sendRequest(request) { sent.push(request); requestListener(request) },
    sendCancellation(cancellation) { cancellations.push(cancellation); cancellationListener(cancellation) } })
  const api = createRendererControlApi({
    onRequest(listener) { requestListener = listener; return () => {} },
    onCancellation(listener) { cancellationListener = listener; return () => {} },
    respond(response) { responses.push({ response, accepted: bridge.accept(response) }) }
  })
  const disposeRenderer = api.onRequest(async (request, signal) => {
    if (request.operation !== 'file.format') throw new Error('Unexpected test operation')
    signals.push(signal)
    const result = await formatFileRegion(request.regionId, signal)
    return { operation: 'file.format', regionId: request.regionId, status: result.status, message: result.message ?? null }
  })
  cleanups.push(disposeRenderer, () => bridge.dispose())
  const observe = (signal?: AbortSignal) => bridge.execute(fileRequest(), signal).then(
    result => ({ result, error: null }), error => ({ result: null, error }))
  return { bridge, sent, cancellations, responses, signals, disposeRenderer, observe }
}
async function flush() { await vi.advanceTimersByTimeAsync(0) }

describe('accepted file.format business and its observer have separate lifetimes', () => {
  it('ends the timed-out reader, keeps the original ID in flight, and applies one late draft edit', async () => {
    const owner = liveEditor(), consumer = connectedConsumer(), observation = consumer.observe()
    await flush()
    const worker = EngineWorker.instances[0]!
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ path: 'current.ts', content: 'const x={a:1}' }))
    await vi.advanceTimersByTimeAsync(agentMuxControlTimeoutMs('file.format'))
    expectEndedObservation((await observation).error, 'CONTROL_TIMEOUT')
    expect(consumer.cancellations).toEqual([])
    expect(consumer.signals[0]!.aborted).toBe(false)
    expect(worker.terminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await expect(consumer.bridge.execute(fileRequest())).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    expect(consumer.sent).toHaveLength(1)
    expect(EngineWorker.instances).toHaveLength(1)
    worker.reply('const x = { a: 1 };\n')
    await flush()
    expect(owner.document.content).toBe('const x = { a: 1 };\n')
    expect(owner.sequence).toEqual(['undoStop', 'edit', 'undoStop'])
    expect(owner.editor.executeEdits).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(consumer.responses).toEqual([{ accepted: true, response: { requestId: fileRequest().requestId, ok: true,
      result: { operation: 'file.format', regionId: fileRequest().regionId, status: 'formatted', message: 'Formatted the draft. Save to write it to disk.' } } }])
    // The actual response retires the ID; it does not create a permanent retry lock.
    const next = consumer.observe()
    await flush()
    expect(EngineWorker.instances).toHaveLength(2)
    EngineWorker.instances[1]!.reply(owner.document.content)
    await flush()
    expect((await next).result).toMatchObject({ status: 'unchanged' })
    expect(owner.editor.executeEdits).toHaveBeenCalledOnce()
  })

  it('detaches an aborted reader without aborting the accepted format; closing source still terminates it', async () => {
    const owner = liveEditor(), consumer = connectedConsumer(), reader = new AbortController()
    const observation = consumer.observe(reader.signal)
    await flush()
    reader.abort()
    expectEndedObservation((await observation).error, 'CONTROL_UNAVAILABLE')
    expect(consumer.cancellations).toEqual([])
    expect(consumer.signals[0]!.aborted).toBe(false)
    await expect(consumer.bridge.execute(fileRequest())).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    expect(EngineWorker.instances[0]!.terminate).not.toHaveBeenCalled()
    owner.unregister() // FileSourceEditor uses this same registration cleanup on hide/close.
    await flush()
    expect(EngineWorker.instances[0]!.terminate).toHaveBeenCalledOnce()
    expect(consumer.responses[0]).toMatchObject({ accepted: true, response: { ok: true, result: { status: 'cancelled' } } })
    EngineWorker.instances[0]!.reply('late cancelled source')
    expect(owner.editor.executeEdits).not.toHaveBeenCalled()
  })

  it('immediately terminates a changed draft even after its reader timed out', async () => {
    const owner = liveEditor(), consumer = connectedConsumer(), observation = consumer.observe()
    await flush()
    await vi.advanceTimersByTimeAsync(agentMuxControlTimeoutMs('file.format'))
    expect((await observation).error).toMatchObject({ code: 'CONTROL_TIMEOUT' })
    owner.edit('new user draft')
    expect(EngineWorker.instances[0]!.terminate).toHaveBeenCalledOnce()
    expect(owner.listeners.size).toBe(0)
    await flush()
    expect(consumer.responses[0]).toMatchObject({ accepted: true, response: { ok: true, result: { status: 'stale' } } })
    EngineWorker.instances[0]!.reply('old formatted source')
    expect(owner.document.content).toBe('new user draft')
    expect(owner.editor.executeEdits).not.toHaveBeenCalled()
  })

  it('owner disposal cancels a format whose reader already ended and rejects its late result', async () => {
    const owner = liveEditor(), consumer = connectedConsumer(), observation = consumer.observe()
    await flush()
    await vi.advanceTimersByTimeAsync(agentMuxControlTimeoutMs('file.format'))
    await observation
    consumer.bridge.dispose()
    expect(consumer.cancellations).toEqual([{ requestId: fileRequest().requestId, code: 'CONTROL_UNAVAILABLE', message: 'Desktop Control owner was disposed.' }])
    expect(consumer.signals[0]!.aborted).toBe(true)
    expect(EngineWorker.instances[0]!.terminate).toHaveBeenCalledOnce()
    EngineWorker.instances[0]!.reply('late disposed source')
    await flush()
    expect(owner.editor.executeEdits).not.toHaveBeenCalled()
    expect(consumer.responses).toEqual([])
    expect(consumer.bridge.accept({ requestId: fileRequest().requestId, ok: true,
      result: { operation: 'file.format', regionId: fileRequest().regionId, status: 'formatted', message: null } })).toBe(false)
  })

  it('Renderer disposal remains a real cancellation after observation ends', async () => {
    const owner = liveEditor(), consumer = connectedConsumer(), observation = consumer.observe()
    await flush()
    await vi.advanceTimersByTimeAsync(agentMuxControlTimeoutMs('file.format'))
    await observation
    consumer.disposeRenderer()
    expect(EngineWorker.instances[0]!.terminate).toHaveBeenCalledOnce()
    expect(consumer.signals[0]!.aborted).toBe(true)
    EngineWorker.instances[0]!.reply('late Renderer result')
    await flush()
    expect(owner.editor.executeEdits).not.toHaveBeenCalled()
    expect(consumer.responses).toEqual([])
  })

  it('retires the in-flight ID when an unavailable Renderer owner is released and can serve its replacement', async () => {
    let available = true
    const sent: DesktopControlRequest[] = [], cancellation = vi.fn()
    const bridge = new DesktopControlIpcBridge({ isAvailable: () => available,
      sendRequest: request => { sent.push(request) }, sendCancellation: cancellation })
    cleanups.push(() => bridge.dispose())
    const first = bridge.execute(fileRequest()).catch(error => error)
    await vi.advanceTimersByTimeAsync(agentMuxControlTimeoutMs('file.format'))
    expectEndedObservation(await first, 'CONTROL_TIMEOUT')
    available = false
    bridge.dispose()
    expect(cancellation).not.toHaveBeenCalled() // No message can reach the dead Renderer.
    expect(bridge.accept({ requestId: fileRequest().requestId, ok: true,
      result: { operation: 'file.format', regionId: fileRequest().regionId, status: 'formatted', message: null } })).toBe(false)
    available = true
    const replacement = bridge.execute(fileRequest())
    expect(sent).toHaveLength(2)
    expect(bridge.accept({ requestId: fileRequest().requestId, ok: true,
      result: { operation: 'file.format', regionId: fileRequest().regionId, status: 'unchanged', message: null } })).toBe(true)
    expect(await replacement).toMatchObject({ status: 'unchanged' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start a request whose reader was already aborted, and releases failed delivery identity', async () => {
    const consumer = connectedConsumer(), reader = new AbortController()
    reader.abort()
    expect((await consumer.observe(reader.signal)).error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(consumer.sent).toEqual([])
    expect(EngineWorker.instances).toEqual([])
    const broken = new DesktopControlIpcBridge({ isAvailable: () => true,
      sendRequest() { throw new Error('Renderer disappeared before delivery') }, sendCancellation: vi.fn() })
    cleanups.push(() => broken.dispose())
    await expect(broken.execute(fileRequest())).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    await expect(broken.execute(fileRequest())).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
