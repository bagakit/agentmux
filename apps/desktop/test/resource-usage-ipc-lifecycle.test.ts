import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { RuntimeController } from '../src/main/runtime-controller'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import type { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent) => unknown>(),
  controlStart: vi.fn(), controlStop: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/isolated-ipc-test' },
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent) => unknown) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel),
    on: vi.fn(), removeListener: vi.fn()
  },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class {
    start = fixture.controlStart
    stop = fixture.controlStop
  }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({
  BrowserProfileManager: class { async initialize() {} async dispose() {} }
}))
vi.mock('../src/main/browser-operation-journal', () => ({
  BROWSER_OPERATION_JOURNAL_FILE: 'isolated-journal.json',
  BrowserOperationFileStore: class {},
  BrowserOperationJournal: class { async ready() {} }
}))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'

class Sender extends EventEmitter {
  constructor(readonly id: number) { super() }
  isDestroyed() { return false }
  send = vi.fn()
}

type Subscription = { unsubscribe: ReturnType<typeof vi.fn>; listener: (snapshot: unknown) => void }
let dispose: (() => Promise<void>) | undefined
let subscriptions: Subscription[]
let active: Set<Subscription>

beforeEach(async () => {
  fixture.handlers.clear()
  fixture.controlStart.mockReset().mockResolvedValue(undefined)
  fixture.controlStop.mockReset().mockResolvedValue(undefined)
  subscriptions = []
  active = new Set()
  const resourceSampler = {
    setObservationSources: () => () => {},
    subscribe(listener: (snapshot: unknown) => void) {
      const subscription: Subscription = { listener, unsubscribe: vi.fn() }
      subscription.unsubscribe.mockImplementation(() => active.delete(subscription))
      subscriptions.push(subscription)
      active.add(subscription)
      return subscription.unsubscribe
    }
  }
  const runtime = {
    resourceSampler, setTerminalViewColors: vi.fn(), prepare: vi.fn().mockResolvedValue({}),
    setContinuousProgressInputObserver: () => () => {},
    commit: vi.fn(), attach: () => () => {}
  } as unknown as RuntimeController
  dispose = await registerIpc({
    window: { webContents: new Sender(1) } as unknown as BrowserWindow,
    runtime,
    progressLoops: { subscribe: () => () => {} } as unknown as ContinuousProgressLoopManager,
    configStore: { get: async () => structuredClone(DEFAULT_CONFIG) } as unknown as ConfigStore,
    scratchTopics: {} as ScratchTopics,
    workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles
  })
  expect(fixture.controlStart).toHaveBeenCalledOnce()
  expect(fixture.handlers.has('resourceUsage:subscribe')).toBe(true)
  expect(fixture.handlers.has('resourceUsage:unsubscribe')).toBe(true)
})
afterEach(async () => { await dispose?.(); dispose = undefined })

function invoke(channel: 'resourceUsage:subscribe' | 'resourceUsage:unsubscribe', sender: Sender) {
  const handler = fixture.handlers.get(channel)
  expect(handler).toBeTypeOf('function')
  return handler!({ sender } as unknown as IpcMainInvokeEvent)
}

function expectReleased(sender: Sender) {
  expect(sender.listenerCount('destroyed')).toBe(0)
  expect(sender.listenerCount('did-start-navigation')).toBe(0)
}

it('releases actual IPC sampler and both lifecycle listeners on every open/close cycle', () => {
  const sender = new Sender(71)
  for (let cycle = 0; cycle < 30; cycle += 1) {
    invoke('resourceUsage:subscribe', sender)
    expect(active.size).toBe(1)
    expect(sender.listenerCount('destroyed')).toBe(1)
    expect(sender.listenerCount('did-start-navigation')).toBe(1)
    invoke('resourceUsage:unsubscribe', sender)
    expect(active.size).toBe(0)
    expectReleased(sender)
    expect(subscriptions[cycle]!.unsubscribe).toHaveBeenCalledOnce()
  }
  expect(subscriptions).toHaveLength(30)
})

it('replaces one sender subscription and ignores its late old cleanup', () => {
  const sender = new Sender(72)
  invoke('resourceUsage:subscribe', sender)
  const oldCleanup = sender.listeners('destroyed')[0]!
  invoke('resourceUsage:subscribe', sender)
  expect(subscriptions).toHaveLength(2)
  expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce()
  expect(subscriptions[1]!.unsubscribe).not.toHaveBeenCalled()
  expect(active.size).toBe(1)
  expect(sender.listenerCount('destroyed')).toBe(1)
  expect(sender.listenerCount('did-start-navigation')).toBe(1)
  oldCleanup()
  expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce()
  expect(subscriptions[1]!.unsubscribe).not.toHaveBeenCalled()
  expect(active.size).toBe(1)
  subscriptions[1]!.listener({ marker: 'replacement remains observable' })
  expect(sender.send).toHaveBeenCalledWith(expect.any(String), { marker: 'replacement remains observable' })
  invoke('resourceUsage:unsubscribe', sender)
  expectReleased(sender)
  expect(active.size).toBe(0)
  expect(subscriptions[1]!.unsubscribe).toHaveBeenCalledOnce()
})

it('preserves a synchronous replacement created while the old owner removes a listener', () => {
  const sender = new Sender(78)
  let reopened = false
  sender.on('removeListener', (event) => {
    if (event !== 'destroyed' || reopened) return
    reopened = true
    invoke('resourceUsage:subscribe', sender)
  })
  invoke('resourceUsage:subscribe', sender)
  invoke('resourceUsage:unsubscribe', sender)
  expect(reopened).toBe(true)
  expect(subscriptions).toHaveLength(2)
  expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce()
  expect(subscriptions[1]!.unsubscribe).not.toHaveBeenCalled()
  expect(active.size).toBe(1)
  expect(sender.listenerCount('destroyed')).toBe(1)
  expect(sender.listenerCount('did-start-navigation')).toBe(1)
  invoke('resourceUsage:unsubscribe', sender)
  expect(active.size).toBe(0)
  expectReleased(sender)
  expect(subscriptions[1]!.unsubscribe).toHaveBeenCalledOnce()
})

it.each(['destroyed', 'did-start-navigation'])('fully releases on %s and remains idempotent', (event) => {
  const sender = new Sender(73)
  invoke('resourceUsage:subscribe', sender)
  const cleanup = sender.listeners(event)[0]!
  sender.emit(event)
  expectReleased(sender)
  expect(active.size).toBe(0)
  cleanup()
  sender.emit(event)
  invoke('resourceUsage:unsubscribe', sender)
  expect(subscriptions).toHaveLength(1)
  expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce()
})

it('keeps another sender observable until it also closes', () => {
  const first = new Sender(74), second = new Sender(75)
  invoke('resourceUsage:subscribe', first)
  invoke('resourceUsage:subscribe', second)
  expect(active.size).toBe(2)
  invoke('resourceUsage:unsubscribe', first)
  expectReleased(first)
  expect(active.size).toBe(1)
  expect(subscriptions).toHaveLength(2)
  subscriptions[1]!.listener({ marker: 'second sender' })
  expect(second.send).toHaveBeenCalledWith(expect.any(String), { marker: 'second sender' })
  expect(subscriptions[1]!.unsubscribe).not.toHaveBeenCalled()
  invoke('resourceUsage:unsubscribe', second)
  expectReleased(second)
  expect(active.size).toBe(0)
})

it('disposes every subscriber through registerIpc owner while preserving unrelated sender listeners', async () => {
  const first = new Sender(76), second = new Sender(77)
  const unrelatedDestroyed = vi.fn(), unrelatedNavigation = vi.fn()
  first.on('destroyed', unrelatedDestroyed)
  first.on('did-start-navigation', unrelatedNavigation)
  invoke('resourceUsage:subscribe', first)
  invoke('resourceUsage:subscribe', second)
  expect(active.size).toBe(2)
  await dispose!()
  dispose = undefined
  expect(active.size).toBe(0)
  expect(subscriptions).toHaveLength(2)
  expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce()
  expect(subscriptions[1]!.unsubscribe).toHaveBeenCalledOnce()
  expect(first.listeners('destroyed')).toEqual([unrelatedDestroyed])
  expect(first.listeners('did-start-navigation')).toEqual([unrelatedNavigation])
  expectReleased(second)
  first.emit('destroyed')
  first.emit('did-start-navigation')
  expect(unrelatedDestroyed).toHaveBeenCalledOnce()
  expect(unrelatedNavigation).toHaveBeenCalledOnce()
  expect(fixture.controlStop).toHaveBeenCalledOnce()
  expect(fixture.handlers.size).toBe(0)
})
