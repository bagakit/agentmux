import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { AgentMuxError, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import type { BrowserWindow } from 'electron'
import type { AgentMuxPreloadApi, SessionControl } from '../src/shared/contracts'
import { RuntimeController } from '../src/main/runtime-controller'
import { createRendererSessionInput } from '../src/renderer/src/lib/session-input'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => '/private-input-confirmation-ipc' },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-input.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'

it('actual Main handlers, preload and Renderer retain known/unknown input prefixes without retry across clone boundaries', async () => {
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const write = vi.spyOn(runtime, 'write'), paste = vi.spyOn(runtime, 'paste')
  const sender = Object.assign(new EventEmitter(), { id: 711, isDestroyed: () => false, send: vi.fn() })
  let dispose: (() => Promise<void>) | undefined
  try {
    dispose = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime,
      configStore: { get: async () => structuredClone(DEFAULT_CONFIG) } as never,
      progressLoops: { subscribe: () => () => {} } as never, scratchTopics: {} as never })
    bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
      const handler = bridge.handlers.get(channel)
      expect(handler).toBeTypeOf('function')
      try { return structuredClone(await handler!({ sender }, ...values)) }
      // Model Electron rejection faithfully: only message survives a thrown Error.
      catch (cause) { throw new Error(cause instanceof Error ? cause.message : String(cause)) }
    })
    expect(bridge.api).not.toBeNull()
    const preload = bridge.api!.sessions
    const api = createRendererSessionInput({ ...preload,
      write: async (...args) => structuredClone(await preload.write(...args)),
      paste: async (...args) => structuredClone(await preload.paste(...args)) })
    const control: SessionControl = { kind: 'terminal', hostId: 'local', runId: 'healthy', run: { runId: 'healthy' } }
    for (const [disposition, confirmedInputBytes] of [['unknown', 3], ['unknown', null], ['not_applied', 0]] as const) {
      const failure = new AgentMuxError('Input write failed.', 'CTXMUX_io', disposition, { disposition, confirmedInputBytes })
      write.mockRejectedValueOnce(failure); paste.mockRejectedValueOnce(failure)
      for (const operation of [() => api.write(control, 'abcdef', 'user'), () => api.paste(control, 'abcdef', 'abcdef')]) {
        const error = await operation().catch(cause => cause)
        expect(error).toMatchObject({ name: 'AgentMuxError', code: 'CTXMUX_io', detail: disposition,
          controlFailure: { disposition, confirmedInputBytes } })
        expect(error.message).toContain(confirmedInputBytes === null ? 'Confirmed input bytes are unknown.' : `Confirmed input prefix: ${confirmedInputBytes} bytes.`)
        expect(error.message).toContain('Input was not resent.')
      }
    }
    expect(write.mock.calls.map(([target, data]) => [target.run.runId, data])).toEqual([
      ['healthy', 'abcdef'], ['healthy', 'abcdef'], ['healthy', 'abcdef']])
    expect(paste.mock.calls.map(([target, text, data]) => [target.run.runId, text, data])).toEqual([
      ['healthy', 'abcdef', 'abcdef'], ['healthy', 'abcdef', 'abcdef'], ['healthy', 'abcdef', 'abcdef']])
    write.mockResolvedValueOnce(); paste.mockResolvedValueOnce()
    await expect(api.write(control, 'new', 'user')).resolves.toBeUndefined()
    await expect(api.paste(control, 'new', 'new')).resolves.toBeUndefined()
  } finally { await dispose?.(); vi.restoreAllMocks() }
})
