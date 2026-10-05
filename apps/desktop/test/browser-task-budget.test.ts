import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
vi.mock('../src/main/browser-operation-feedback', () => ({ showBrowserOperationFeedback: () => ({ end: vi.fn(async () => {}), clear: vi.fn() }) }))
vi.mock('../src/main/browser-script-runner', async original => ({ ...await original<any>(), runBrowserScript: vi.fn(async () => ({ completed: true, value: 'original script result', logs: [] })) }))
import { BrowserViewManager } from '../src/main/browser-view-manager'
import { BrowserCdpSession } from '../src/main/browser-cdp-session'
import { runBrowserScript } from '../src/main/browser-script-runner'
afterEach(() => vi.restoreAllMocks())
it('actual page dispatcher refuses a call whose preparation used the remaining deadline', async () => {
  let clock = 1000; vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const operation = { id: 'original-op', browserId: 'original-browser', phase: 'running', steps: [] }
  const entry = { id: 'original-browser', view: { webContents: { isDestroyed: () => false } }, navigationId: 'original-nav', activeRun: { operationId: operation.id }, activity: { control: 'agent' }, feedback: {
    begin: vi.fn(async () => { clock = 1006; return 1 }), clear: vi.fn(), completeAction: vi.fn()
  } }
  const manager = Object.create(BrowserViewManager.prototype)
  Object.assign(manager, { entries: new Map([[entry.id, entry]]), refLedgers: { read: vi.fn(async () => null), write: vi.fn() }, taskAssets: { isExecutionCurrent: () => true } })
  vi.spyOn(manager as any, 'emit').mockImplementation(() => {})
  const native = vi.spyOn(manager as any, 'startNavigation').mockResolvedValue(undefined)
  const sender = { sendCommand: vi.fn(), frames: new Map() }
  const cursor = { browserId: entry.id, runId: 'original-run', assetId: 'original-asset', version: 1, stepId: 'step', deadlineMillis: 1005 }
  const dispatch = (manager as any).pageCallHandler(entry, sender, [], operation, false, new AbortController().signal, { cursor })
  await expect(dispatch('gotoUrl', ['https://fixture.invalid/next'])).rejects.toThrow('budget reached before page dispatch')
  expect(entry.feedback.begin).toHaveBeenCalledOnce(); expect(native).not.toHaveBeenCalled(); expect(sender.sendCommand).not.toHaveBeenCalled()
})
it('actual BVM passes only remaining time after asynchronous preparation to the original script owner', async () => {
  let clock = 1000; vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const entry = { id: 'original-browser', view: { webContents: contents }, navigationId: 'original-nav', requestedUrl: 'https://fixture.invalid/', activity: { control: 'agent' }, feedbackRevision: 0 }
  const manager = Object.create(BrowserViewManager.prototype)
  Object.assign(manager, { entries: new Map([[entry.id, entry]]), refLedgers: { read: vi.fn(async () => null), write: vi.fn() } })
  vi.spyOn(manager as any, 'releaseDemonstrationCapture').mockImplementation(() => {})
  vi.spyOn(manager as any, 'emit').mockImplementation(() => {})
  vi.spyOn(BrowserCdpSession, 'attach').mockReturnValue({ endedReason: null, detach: () => undefined, frames: new Map() } as any)
  const cursor = { browserId: entry.id, runId: 'original-run', assetId: 'original-asset', version: 1, stepId: 'step', deadlineMillis: 1025 }
  const report = await manager.runScript(entry.id, 'return 1', undefined, undefined, undefined, async () => { clock = 1020 }, false, { cursor })
  expect(report.outcome.kind).toBe('completed')
  expect(vi.mocked(runBrowserScript).mock.calls).toHaveLength(1)
  expect(vi.mocked(runBrowserScript).mock.calls[0]![0]).toMatchObject({ timeoutMs: 5 })
  vi.mocked(runBrowserScript).mockClear(); clock = 1025
  await expect(manager.runScript(entry.id, 'return 1', undefined, undefined, undefined, undefined, false, { cursor })).rejects.toThrow('budget reached before script dispatch')
  expect(runBrowserScript).not.toHaveBeenCalled()
  expect((entry as any).runInFlight).toBe(false)
})
