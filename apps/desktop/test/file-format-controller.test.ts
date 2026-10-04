import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelFileRegionFormat, formatFileRegion, registerFileRegionFormatter } from '../src/renderer/src/lib/file-formats/format-file-region'
import { monacoFormatAdapter } from '../src/renderer/src/lib/file-formats/monaco-format-adapter'

const cleanups: (() => void)[] = [], workers: any[] = []
let requestThrows = false
beforeEach(() => {
  workers.length = 0; requestThrows = false
  vi.stubGlobal('Worker', class {
    onmessage: any; onerror: any; onmessageerror: any
    terminate = vi.fn(); postMessage = vi.fn(() => { if (requestThrows) throw new Error('clone') })
    constructor() { workers.push(this) }
  })
})
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals() })
function editorOwner(path = 'example.ts') {
  const state = { content: 'const x={a:1}', generation: 3, live: true }
  const sequence: string[] = []
  const listeners = new Set<() => void>()
  const subscribe = (callback: () => void) => { listeners.add(callback); return { dispose: () => listeners.delete(callback) } }
  const model = { isDisposed: () => false, getValue: () => state.content, getVersionId: () => state.generation,
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: state.content.length + 1 }), onDidChangeContent: subscribe }
  const editor = { getModel: () => model, pushUndoStop: vi.fn(() => { sequence.push('undoStop'); return true }),
    onDidChangeModel: subscribe,
    executeEdits: vi.fn((_source: string, edits: { text: string }[]) => { sequence.push('edit'); state.content = edits[0]!.text; state.generation++; for (const callback of listeners) callback(); return true }) }
  const adapter = monacoFormatAdapter(editor as any, { path, isLive: () => state.live, read: () => state })
  return { state, model, editor, adapter, sequence, changed: () => { for (const callback of [...listeners]) callback() }, listeners }
}
function register(id: string, owner: ReturnType<typeof editorOwner>) { const cleanup = registerFileRegionFormatter(id, owner.adapter); cleanups.push(cleanup); return cleanup }
function respond(worker: any, content: string, error?: string) {
  const request = worker.postMessage.mock.calls[0][0]
  worker.onmessage({ data: { id: request.id, content, ...(error ? { error } : {}) } })
}
describe('exact File Region formatting action', () => {
  it('uses the live Monaco draft and one undo-delimited executeEdits operation', async () => {
    const owner = editorOwner(); register('one', owner)
    const result = formatFileRegion('one')
    expect(workers).toHaveLength(1)
    expect(workers[0].postMessage.mock.calls[0][0]).toMatchObject({ path: 'example.ts', content: owner.state.content })
    respond(workers[0], 'const x = { a: 1 };\n')
    expect((await result).status).toBe('formatted')
    expect(owner.sequence).toEqual(['undoStop', 'edit', 'undoStop'])
    expect(owner.editor.executeEdits).toHaveBeenCalledExactlyOnceWith('agentmux.formatDocument', [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 14 }, text: 'const x = { a: 1 };\n', forceMoveMarkers: true }])
    expect(workers[0].terminate).toHaveBeenCalledOnce()
  })
  it('refuses a result after generation/source changed and does not overwrite the new draft', async () => {
    const owner = editorOwner(); register('stale', owner)
    const apply = vi.spyOn(owner.adapter, 'apply')
    const result = formatFileRegion('stale')
    owner.state.content = 'new user draft'; owner.state.generation++
    respond(workers[0], 'old formatted source')
    expect((await result).status).toBe('stale')
    expect(owner.state.content).toBe('new user draft')
    expect(owner.editor.executeEdits).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
  })
  it('cancel/unregister stop only their own Worker and late responses cannot edit', async () => {
    const a = editorOwner(), b = editorOwner(); register('A', a); const unregisterB = register('B', b)
    const first = formatFileRegion('A'), second = formatFileRegion('B')
    cancelFileRegionFormat('A')
    expect((await first).status).toBe('cancelled')
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers[1].terminate).not.toHaveBeenCalled()
    respond(workers[0], 'late cancelled source')
    expect(a.editor.executeEdits).not.toHaveBeenCalled()
    unregisterB()
    expect((await second).status).toBe('cancelled')
    expect(workers[1].terminate).toHaveBeenCalledOnce()
  })
  it('terminates immediately when the current model changes, before any worker response', async () => {
    const owner = editorOwner(); register('immediate', owner)
    const result = formatFileRegion('immediate')
    expect(owner.listeners.size).toBeGreaterThan(0)
    owner.state.content = 'typed while formatting'; owner.state.generation++; owner.changed()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect((await result).status).toBe('stale')
    expect(owner.listeners.size).toBe(0)
    respond(workers[0], 'old formatted source')
    expect(owner.editor.executeEdits).not.toHaveBeenCalled()
  })
  it('public operation abort cancels only its own job and cannot apply a late result', async () => {
    const owner = editorOwner(); register('abort', owner)
    const signal = new AbortController(), result = formatFileRegion('abort', signal.signal)
    signal.abort()
    expect((await result).status).toBe('cancelled')
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(owner.listeners.size).toBe(0)
    respond(workers[0], 'late aborted format')
    expect(owner.editor.executeEdits).not.toHaveBeenCalled()
    expect((await formatFileRegion('abort', signal.signal)).status).toBe('cancelled')
    expect(workers).toHaveLength(1)
  })
  it('returns unchanged/errors precisely, releases on failure and never starts unsupported work', async () => {
    expect((await formatFileRegion('absent')).status).toBe('unavailable')
    const unsupported = editorOwner('data.toml'); register('unsupported', unsupported)
    expect((await formatFileRegion('unsupported')).status).toBe('unsupported')
    expect(workers).toHaveLength(0)
    const owner = editorOwner(); register('one', owner)
    const unchanged = formatFileRegion('one'); respond(workers[0], owner.state.content)
    expect((await unchanged).status).toBe('unchanged')
    expect(owner.editor.executeEdits).not.toHaveBeenCalled()
    const failed = formatFileRegion('one'); respond(workers[1], '', 'Parse error')
    expect(await failed).toEqual({ status: 'failed', message: 'Parse error' })
    expect(workers[1].terminate).toHaveBeenCalledOnce()
    const stopped = formatFileRegion('one'); workers[2].onerror()
    expect((await stopped).status).toBe('failed')
    expect(workers[2].terminate).toHaveBeenCalledOnce()
    const unreadable = formatFileRegion('one'); workers[3].onmessageerror()
    expect((await unreadable).status).toBe('failed')
    expect(workers[3].terminate).toHaveBeenCalledOnce()
    const snapshot = vi.spyOn(owner.adapter, 'snapshot').mockImplementation(() => { throw new Error('closed model') })
    expect((await formatFileRegion('one')).status).toBe('failed')
    snapshot.mockRestore()
    requestThrows = true
    const badRequest = formatFileRegion('one')
    expect((await badRequest).status).toBe('failed')
    expect(workers.at(-1).terminate).toHaveBeenCalledOnce()
    requestThrows = false
  })
  it('checks model identity/version/liveness at the adapter and old unregister cannot remove a new owner', async () => {
    const old = editorOwner(), next = editorOwner(); const unregisterOld = register('same', old)
    const snapshot = old.adapter.snapshot()!
    expect(old.adapter.isCurrent(snapshot)).toBe(true)
    old.state.live = false
    expect(old.adapter.isCurrent(snapshot)).toBe(false)
    expect(old.adapter.apply(snapshot, 'unsafe')).toBe(false)
    register('same', next); unregisterOld()
    const result = formatFileRegion('same'); respond(workers[0], 'new owner format')
    expect((await result).status).toBe('formatted')
    expect(next.editor.executeEdits).toHaveBeenCalledOnce()
  })
})
