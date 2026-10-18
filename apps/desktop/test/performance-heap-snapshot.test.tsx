// @vitest-environment happy-dom
import { act, useState } from 'react'
import type { Root } from 'react-dom/client'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), save: vi.fn(), reveal: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld(_key: string, value: AgentMuxPreloadApi) { bridge.api = value } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() }, webFrame: {},
  dialog: { showSaveDialog: bridge.save }, shell: { showItemInFolder: bridge.reveal } }))
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { usePerformanceHeapSnapshot } from '../src/renderer/src/lib/use-performance-heap-snapshot'
import { PerformanceHeapSnapshot } from '../src/renderer/src/components/performance/PerformanceHeapSnapshot'
import { currentPerformanceCaptureTarget } from '../src/renderer/src/components/performance/PerformanceCapture'
import { RendererHeapSnapshotOwner } from '../src/main/renderer-heap-snapshot'
import { registerPerformanceCaptureIpc } from '../src/main/performance-capture-ipc'
import { registerHeapSnapshotFileIpc } from '../src/main/renderer-heap-snapshot-ipc'
import { createResourceMetricsPort } from '../src/main/resource-usage-control'
import { durableWriteFile } from '../../../packages/core/src/durable-write'
import { performanceAttributionSnapshots as samples } from '../scripts/fixtures/performance-panel/data'

let root: Root, container: HTMLDivElement, directory: string, failPublication: boolean
let owner: RendererHeapSnapshotOwner, port: ReturnType<typeof createResourceMetricsPort>
let contents: ReturnType<typeof nativeContents>
const target = currentPerformanceCaptureTarget(samples.fresh.observation)!
const material = JSON.stringify({ snapshot: {}, nodes: [1, 2], strings: ['controlled-held-object'] })
const handlers = new Map<string, (event: never, input: unknown) => unknown>()
function nativeContents() {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, isDevToolsOpened: () => false,
    debugger: { isAttached: () => false }, openDevTools: vi.fn(),
    takeHeapSnapshot: vi.fn(async (path: string) => { await writeFile(path, material) }) })
}
function Harness() {
  const state = usePerformanceHeapSnapshot(), [visible, setVisible] = useState(true)
  return <><button data-toggle onClick={() => setVisible(v => !v)}>Toggle</button>
    {visible ? <PerformanceHeapSnapshot state={state} observation={samples.fresh.observation} /> : null}</>
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  directory = await mkdtemp(join(tmpdir(), 'heap-ui-')); failPublication = false
  owner = new RendererHeapSnapshotOwner(directory, async (...args) => {
    if (failPublication && args[0].endsWith('/latest.json')) throw new Error('Controlled metadata publication failure')
    await durableWriteFile(...args)
  })
  contents = nativeContents()
  port = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => samples.fresh.observation!.window,
    heap: { owner, dependencies: { contents: contents as unknown as WebContents, currentTarget: () => target,
      host: () => ({ kind: 'unix-host', hostId: 'local', hostname: 'fixture-host', mainPid: 6 }) } } })
  handlers.clear()
  const register = (name: string, handler: (event: never, input: unknown) => unknown) => handlers.set(name, handler)
  registerPerformanceCaptureIpc(port, register)
  registerHeapSnapshotFileIpc(owner, { webContents: contents } as unknown as BrowserWindow, () => target, register)
  bridge.invoke.mockImplementation((name, input) => handlers.get(name)!(undefined as never, input))
  for (const name of ['captureHeapSnapshot', 'inspectHeapSnapshot', 'saveHeapSnapshot', 'revealHeapSnapshot', 'openHeapDevTools'] as const)
    vi.spyOn(api.performance, name).mockImplementation(((input: never) => bridge.api!.performance[name](input)) as never)
  bridge.save.mockResolvedValue({ canceled: false, filePath: join(directory, 'export.heapsnapshot') })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); port.dispose(); owner.dispose()
  await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals()
  bridge.invoke.mockReset(); bridge.save.mockReset(); bridge.reveal.mockReset()
})
const click = async (text: string) => act(async () => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)
  expect(button, 'Actual mounted action is present: ' + text).toBeTruthy(); button!.click()
})

it('uses the actual Performance hook, preload, registered Main owners and native file save/reveal/DevTools actions', async () => {
  await act(async () => root.render(<Harness />))
  expect(contents.takeHeapSnapshot).not.toHaveBeenCalled(); expect(bridge.invoke).not.toHaveBeenCalled()
  await click('Take heap snapshot')
  await vi.waitFor(() => expect(container.textContent).toContain('Original publication confirmed.'))
  expect(contents.takeHeapSnapshot).toHaveBeenCalledOnce()
  const captureInput = bridge.invoke.mock.calls.find(call => call[0] === 'metrics:captureHeapSnapshot')![1]
  expect(captureInput.target).toEqual(target)
  expect(captureInput.captureId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/u)
  // Observe the real export integrity check without replacing its file I/O.
  const fingerprints = vi.spyOn(owner as unknown as { fingerprint(path: string): Promise<unknown> }, 'fingerprint')
  await click('Save snapshot…')
  await vi.waitFor(() => expect(container.textContent).toContain('Saved to'))
  expect(await readFile(join(directory, 'export.heapsnapshot'), 'utf8')).toBe(material)
  expect(fingerprints.mock.calls.map(([path]) => path)).toContainEqual(expect.stringMatching(/\/\.amux-heap-[1-9A-HJ-NP-Za-km-z]{12}\.tmp$/u))
  await click('Reveal file'); await vi.waitFor(() => expect(bridge.reveal).toHaveBeenCalledOnce())
  expect(bridge.reveal).toHaveBeenCalledWith(join(directory, captureInput.captureId + '.heapsnapshot'))
  await click('Open DevTools'); await vi.waitFor(() => expect(contents.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach' }))
  await click('Toggle'); await click('Toggle')
  expect(container.textContent).toContain(captureInput.captureId)
  expect(contents.takeHeapSnapshot).toHaveBeenCalledOnce()
})

it('explicitly retries only the original receipt publication through the same captureId without collecting twice', async () => {
  failPublication = true
  await act(async () => root.render(<Harness />)); await click('Take heap snapshot')
  await vi.waitFor(() => expect(container.textContent).toContain('Controlled metadata publication failure'))
  expect(contents.takeHeapSnapshot).toHaveBeenCalledOnce(); failPublication = false
  await click('Retry saving receipt')
  await vi.waitFor(() => expect(container.textContent).toContain('Original publication confirmed.'))
  const calls = bridge.invoke.mock.calls.filter(call => call[0] === 'metrics:captureHeapSnapshot')
  expect(calls).toHaveLength(2); expect(calls[1]![1]).toEqual(calls[0]![1])
  expect(contents.takeHeapSnapshot).toHaveBeenCalledOnce()
})

it('shows native failure and lets explicit inspection read the original attempt without recapturing', async () => {
  contents.takeHeapSnapshot.mockRejectedValueOnce(new Error('Controlled native capture failed'))
  await act(async () => root.render(<Harness />)); await click('Take heap snapshot')
  await vi.waitFor(() => expect(container.textContent).toContain('Controlled native capture failed'))
  expect(container.textContent).toContain('Snapshot failed')
  await click('Inspect original')
  await vi.waitFor(() => expect(bridge.invoke.mock.calls.filter(call => call[0] === 'metrics:inspectHeapSnapshot')).toHaveLength(1))
  expect(bridge.invoke.mock.calls.find(call => call[0] === 'metrics:inspectHeapSnapshot')![1]).toEqual({
    captureId: bridge.invoke.mock.calls.find(call => call[0] === 'metrics:captureHeapSnapshot')![1].captureId
  })
  expect(contents.takeHeapSnapshot).toHaveBeenCalledOnce()
  expect(bridge.save).not.toHaveBeenCalled(); expect(bridge.reveal).not.toHaveBeenCalled()
})

it('does not transfer an earlier publication acknowledgement to a later capture with a lost reply', async () => {
  await act(async () => root.render(<Harness />)); await click('Take heap snapshot')
  await vi.waitFor(() => expect(container.textContent).toContain('Original publication confirmed.'))
  bridge.invoke.mockImplementation(async (name, input) => {
    const result = await handlers.get(name)!(undefined as never, input)
    if (name === 'metrics:captureHeapSnapshot') throw new Error('Controlled lost second reply')
    return result
  })
  await click('Take heap snapshot'); await vi.waitFor(() => expect(container.textContent).toContain('Controlled lost second reply'))
  expect(contents.takeHeapSnapshot).toHaveBeenCalledTimes(2)
  await click('Inspect original')
  await vi.waitFor(() => expect(container.textContent).toContain('Original file observed; earlier write acknowledgement is unavailable.'))
  expect(container.textContent).not.toContain('Original publication confirmed.')
  expect(contents.takeHeapSnapshot).toHaveBeenCalledTimes(2)
})
