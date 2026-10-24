// @vitest-environment happy-dom
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { act, useEffect } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { consumeConversationWindowPage, type ConversationWindowAssembly } from '@agentmux/core/conversation'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import type { AgentSessionControl, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { useAppStore } from '../src/renderer/src/store'
import { agentHistoryMenuEntry, openAgentHistory } from './helpers/agent-history-menu'
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { ConversationAnnotationOwner } from './helpers/conversation-annotation-owner'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import * as markdown from '../../../packages/client-ui/src/lib/agent-markdown'

const observation = vi.hoisted(() => ({ enabled: false, refresh: vi.fn<() => Promise<void>>() }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({
    visible = true,
    onObservationRefresh,
  }: {
    visible?: boolean
    onObservationRefresh?: (refresh: (() => Promise<void>) | null) => void
  }) => {
    useEffect(() => {
      if (observation.enabled) {
        onObservationRefresh?.(observation.refresh)
        return () => onObservationRefresh?.(null)
      }
    }, [onObservationRefresh])
    return (
      <div className="terminal-view" data-visible={visible}>
        Retained terminal surface
      </div>
    )
  },
}))
const controlA: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'session-reading-a',
  run: { runId: 'run-a' },
}
const controlB: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'session-reading-b',
  run: { runId: 'run-b' },
}
const initial = useAppStore.getState()
const nativeSource = { providerId: 'codex', nativeSessionId: 'native-reading-source' }
let host: HTMLDivElement, root: Root, closes: Array<() => unknown | Promise<unknown>>
let intersections: Array<{ targets: Set<Element>; deliver(entries: IntersectionObserverEntry[]): void }>
let historyPageSpy: MockInstance<typeof api.sessions.historyPage>
const wait = (assertion: () => void) =>
  vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      assertion()
    },
    { timeout: 8000, interval: 10 },
  )
type TraceElement = HTMLDetailsElement | HTMLButtonElement
const TRACE_SELECTOR = 'details.log-turn__trace[data-trace-kind="reasoning"], button.conversation-tool-trace__row'
const traces = (scope: ParentNode = host) => [...scope.querySelectorAll<TraceElement>(TRACE_SELECTOR)]
function isTraceOpen(el: TraceElement): boolean {
  return el.tagName === 'DETAILS' ? (el as HTMLDetailsElement).open : el.getAttribute('aria-expanded') === 'true'
}
function openTrace(el: TraceElement): void {
  if (el.tagName === 'DETAILS') {
    ;(el as HTMLDetailsElement).open = true
    el.dispatchEvent(new Event('toggle'))
  } else {
    expect(el.getAttribute('aria-expanded')).toBe('false')
    el.click()
  }
}
const native = (
  id: string,
  parts: AgentSessionHistoryContentPart[] = [{ kind: 'text', text: `Message body for ${id}` }],
): AgentSessionHistoryItem => ({ id, kind: 'assistant-message', contentParts: parts })
const call = (callId: string, input = callId): AgentSessionHistoryContentPart => ({
  kind: 'tool-call',
  name: 'shell',
  callId,
  input,
})
const body = (text: string): AgentSessionHistoryContentPart => ({ kind: 'text', text })
const nativeIds = () =>
  [...host.querySelectorAll<HTMLElement>('.conversation-native-thread > [data-native-record-id]')].map(
    (row) => row.dataset.nativeRecordId!,
  )
const turn = (id: string, scope: ParentNode = host) => {
  const row = [...scope.querySelectorAll<HTMLElement>('[data-native-record-id]')].find(
    (row) => row.dataset.nativeRecordId === id,
  )
  expect(row, id).toBeDefined()
  return row!
}
function sample(control = controlA) {
  return inspectConversationConsumers(control).consumers[0]!
}
function action(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === label,
  )
  expect(button, label).toBeDefined()
  return button!
}
async function click(label: string) {
  await act(async () => action(label).click())
}
async function earlierReady() {
  await wait(() => {
    expect(nativeIds()).toHaveLength(100)
    expect(sample()).toMatchObject({ loading: false, inFlight: false, dirty: false, error: null })
    expect(action('Earlier').disabled).toBe(false)
  })
}
async function headerObservationAction(scope: ParentNode, label: string) {
  await agentHistoryMenuEntry(scope)
  const more = scope.querySelector<HTMLButtonElement>('.agent-region-header__more')!
  const menu = document.getElementById(more.getAttribute('aria-controls')!)!
  let item: HTMLElement | undefined
  await wait(() => {
    item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (entry) => entry.textContent?.trim() === label,
    )
    expect(item, label).toBeDefined()
  })
  return item!
}
function nativeParentSession(workspacePath: string, control = controlA): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    ...composerSession(control.agentSessionId, 'codex'),
    control,
    hostId: control.hostId,
    workspacePath,
    label: 'Private native parent',
    status: { state: 'done', source: 'native-hook', observedAt: 1 },
  }
}
async function fixture(items: AgentSessionHistoryItem[], control = controlA) {
  let originals = items
  const f = await conversationPagePortFixture(control, nativeSource, async (_sid, options = {}) => {
    const end = options.cursor ? Number(options.cursor.slice('original:'.length)) : originals.length
    const start = Math.max(0, end - (options.limit ?? 100))
    return {
      agentSessionId: control.agentSessionId,
      source: nativeSource,
      items: originals.slice(start, end),
      nextCursor: start ? `original:${start}` : null,
    }
  })
  closes.push(f.close)
  closes.push(() => expect(f.controls.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]))
  const stored = await f.client.readAgentSession(control.agentSessionId)
  if (!stored) throw new Error('The original fixture Session metadata was not found')
  expect(stored).toMatchObject({ kind: 'agent', hostId: control.hostId, agentSessionId: control.agentSessionId })
  const actualControl: AgentSessionControl = { ...control, run: stored.run }
  const render = (enabled = true, identity = control.run.runId) =>
    act(async () =>
      root.render(
        <ActivityView {...activityReadingProps({ control: actualControl, visible: enabled, readingKey: identity })} />,
      ),
    )
  const current = async () => {
    let cursor: string | undefined, pending: ConversationWindowAssembly | undefined
    for (let index = 0; index < 20; index++) {
      const page = await api.conversation.readAgentConversation({
        hostId: control.hostId,
        agentSessionId: control.agentSessionId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      const frame = consumeConversationWindowPage(page, pending)
      if (frame.kind === 'complete') return frame.snapshot
      pending = frame.pending
      cursor = page.nextCursor!
      expect(cursor).toBeTruthy()
    }
    throw new Error('The real public current frame did not complete')
  }
  const draw = async () => {
    const reading = projectConversationWindow(await current())
    await act(async () =>
      root.render(
        <ConversationView
          sessionId={control.agentSessionId}
          executionHostId={control.hostId}
          page={reading.historyPage ?? null}
          timeline={reading.captured}
          records={reading.records}
          originalRecords={reading.originalRecords}
          coverage={reading.timeline.coverage}
        />,
      ),
    )
  }
  return {
    ...f,
    actualControl,
    workspacePath: stored.workspacePath,
    render,
    current,
    draw,
    replace: (next: AgentSessionHistoryItem[]) => {
      originals = next
    },
  }
}
function holdNextRead(
  predicate: (input: Parameters<typeof api.conversation.readAgentConversation>[0]) => boolean = () => true,
) {
  const original = vi.mocked(api.conversation.readAgentConversation).getMockImplementation()!
  let entered = false,
    returned = false,
    release!: () => void
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (...args) => {
    const hold = !entered && predicate(args[0])
    if (hold) entered = true
    const page = await original(...args)
    if (hold) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      returned = true
    }
    return page
  })
  closes.push(() => release?.())
  return { entered: () => entered && typeof release === 'function', returned: () => returned, release: () => release() }
}
function geometry() {
  const feed = host.querySelector<HTMLElement>('.activity-feed')!
  expect(feed).not.toBeNull()
  Object.defineProperties(feed, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
  })
  const tail = feed.querySelector<HTMLElement>('[data-conversation-reading-tail]')!
  expect(tail).not.toBeNull()
  feed.getBoundingClientRect = () => new DOMRect(0, 0, 500, 400)
  tail.getBoundingClientRect = () => new DOMRect(0, 1000 - feed.scrollTop, 500, 0)
  return {
    feed,
    scroll: async (top: number) => {
      feed.scrollTop = top
      await act(async () => feed.dispatchEvent(new Event('scroll')))
    },
  }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  intersections = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      targets = new Set<Element>()
      constructor(callback: IntersectionObserverCallback) {
        intersections.push({
          targets: this.targets,
          deliver: (entries) => callback(entries, this as unknown as IntersectionObserver),
        })
      }
      observe(node: Element) {
        this.targets.add(node)
      }
      unobserve(node: Element) {
        this.targets.delete(node)
      }
      disconnect() {
        this.targets.clear()
      }
    },
  )
  Element.prototype.scrollIntoView = vi.fn()
  observation.enabled = false
  observation.refresh.mockReset()
  closes = []
  useAppStore.setState({
    config: composerConfig,
    sessions: [],
    error: null,
    lastError: null,
    errorNoticeContext: null,
    errorDismissed: false,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  historyPageSpy = vi.spyOn(api.sessions, 'historyPage')
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
})
afterEach(async () => {
  const failures: unknown[] = []
  try { await act(async () => root.unmount()) } catch (error) { failures.push(error) }
  host.remove(); getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Original reading-state fixture cleanup failed')
})

describe('Conversation reading state through current Core and presentation owners', () => {
  it('preserves the actual Header Portal and Header/Lifecycle observation refresh ownership and busy state across read-only presentation', async () => {
    observation.enabled = true
    const originalRefresh = useAppStore.getState().refreshSession
    const originalRecover = useAppStore.getState().recoverSession
    const refreshSession = vi.fn().mockResolvedValue(undefined)
    const recoverSession = vi.fn().mockResolvedValue(undefined)
    let release!: () => void
    observation.refresh.mockImplementation(
      () =>
        new Promise<void>((done) => {
          release = done
        }),
    )
    const portal = document.createElement('div')
    portal.id = 'private-t028-header-portal'
    document.body.append(portal)
    useAppStore.setState({
      sessions: [nativeParentSession(fixturePath('private-observation'))],
      config: composerConfig,
      viewModes: { [controlA.agentSessionId]: 'terminal' },
      refreshSession,
      recoverSession,
    })
    useAppStore.getState().reportError(new Error('Private retained observation failure'), {
      kind: 'indeterminate',
      lifecycle: { step: 'resume', subject: controlA, lastProcessState: 'running' },
    })
    const render = (readOnly: boolean) =>
      root.render(
        <SessionPane
          sessionId={controlA.agentSessionId}
          surfaceKind="agent"
          interactiveResize={false}
          visible
          readOnly={readOnly}
          headerPortalTargetId={portal.id}
          linkOrigin={{ workspaceId: 'w', tabGroupId: 'g', tabId: 't', regionId: 'private-observation-region' }}
        />,
      )
    try {
      await act(async () => render(false))
      expect(portal.querySelectorAll('.agent-region-header')).toHaveLength(1)
      expect(host.querySelectorAll('.agent-region-header')).toHaveLength(0)
      const headerRefresh = await headerObservationAction(portal, 'Refresh observation')
      await act(async () => headerRefresh.click())
      // Radix returns focus on the next browser task after selection. Finish that task
      // before simulating a second keyboard gesture in the same happy-dom turn.
      await act(async () => {
        await new Promise<void>((done) => setTimeout(done, 0))
      })
      expect(observation.refresh).toHaveBeenCalledTimes(1)
      const lifecycleButtons = [...host.querySelectorAll<HTMLButtonElement>('.agent-launch-notice button')].filter(
        (button) => button.textContent === 'Refresh observation' || button.textContent === 'Retry Resume',
      )
      expect(lifecycleButtons.map((button) => button.textContent)).toEqual(['Refresh observation', 'Retry Resume'])
      expect(lifecycleButtons.map((button) => button.disabled)).toEqual([true, true])
      const busyRefresh = await headerObservationAction(portal, 'Refreshing observation…')
      expect(busyRefresh.getAttribute('aria-disabled')).toBe('true')
      await act(async () => release())
      expect(lifecycleButtons.map((button) => button.disabled)).toEqual([false, false])
      await act(async () => render(true))
      expect(portal.querySelectorAll('.agent-region-header')).toHaveLength(0)
      expect(host.querySelectorAll('.agent-region-header')).toHaveLength(1)
      const lifecycleRefresh = [...host.querySelectorAll<HTMLButtonElement>('.agent-launch-notice button')].find(
        (button) => button.textContent === 'Refresh observation',
      )
      expect(lifecycleRefresh).toBeDefined()
      await act(async () => lifecycleRefresh!.click())
      expect(observation.refresh).toHaveBeenCalledTimes(2)
      expect(lifecycleRefresh!.disabled).toBe(true)
      await act(async () => release())
      expect(lifecycleRefresh!.disabled).toBe(false)
      expect(refreshSession).toHaveBeenCalledTimes(0)
      expect(recoverSession).toHaveBeenCalledTimes(0)
      expect(historyPageSpy).toHaveBeenCalledTimes(0)
    } finally {
      await act(async () => root.unmount())
      root = createRoot(host)
      portal.remove()
      useAppStore.setState({ refreshSession: originalRefresh, recoverSession: originalRecover })
    }
  })

  it.each(['plain-normal-record', 'native:quoted"record\\tail'])(
    'the actual SessionPane preserves native %s disclosure, original TextNode and Range through close/reopen and mode roundtrip',
    async (id) => {
      const f = await nativeHistoryFixture(
        'claude',
        jsonl([
          {
            uuid: id,
            type: 'assistant',
            sessionId: 'native-main',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'x:tool-call:y', name: 'shell', input: { command: 'original command' } },
                { type: 'text', text: 'Selectable native body' },
              ],
            },
          },
        ]),
        { agentSessionId: controlA.agentSessionId },
      )
      closes.push(f.close)
      await f.store.readCapturedHistory(controlA.agentSessionId)
      const before = await f.bytes(), originalRead = f.client['readSessionHistoryPage']
      const readDescriptor = Object.getOwnPropertyDescriptor(f.client, 'readSessionHistoryPage')
      const nativeRead = vi.fn<typeof originalRead>((...args) => originalRead.call(f.client, ...args))
      f.client['readSessionHistoryPage'] = nativeRead
      closes.push(() => {
        if (readDescriptor) Object.defineProperty(f.client, 'readSessionHistoryPage', readDescriptor)
        else Reflect.deleteProperty(f.client, 'readSessionHistoryPage')
      })
      closes.push(async () => {
        expect(await f.bytes()).toEqual(before)
        expect(f.controls.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
      })
      await desktopConversationReadBridge(f, closes)
      const control = { ...controlA, run: f.session.run }
      useAppStore.setState({
        sessions: [{ ...nativeParentSession(f.root, control), providerId: 'claude', executorId: 'claude' }],
        viewModes: { [control.agentSessionId]: 'terminal' },
      })
      await act(async () =>
        root.render(
          <SessionPane
            sessionId={control.agentSessionId}
            surfaceKind="agent"
            interactiveResize={false}
            visible
            readOnly
            linkOrigin={{ workspaceId: 'w', tabGroupId: 'g', tabId: 't', regionId: 'native-region' }}
          />,
        ),
      )
      expect(nativeRead).not.toHaveBeenCalled()
      await openAgentHistory(host)
      await wait(() => {
        expect(nativeIds()).toEqual([id])
        expect(sample(control).loading).toBe(false)
      })
      const trace = traces()[0]!
      expect(trace).toBeDefined()
      await act(async () => openTrace(trace))
      const text = turn(id).querySelector('.log-turn__body p')!.firstChild!,
        range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 10)
      getSelection()!.addRange(range)
      const feed = host.querySelector('.activity-feed')!,
        count = nativeRead.mock.calls.length
      const back = host.querySelector<HTMLButtonElement>('[aria-label="Return to Terminal"]')!
      expect(back).not.toBeNull()
      await act(async () => back.click())
      expect(feed.closest('[hidden]')).not.toBeNull()
      expect(text.isConnected).toBe(true)
      await openAgentHistory(host)
      await wait(() => expect(sample(control).loading).toBe(false))
      expect(feed.closest('[hidden]')).toBeNull()
      expect(traces()[0]).toBe(trace)
      expect(isTraceOpen(trace)).toBe(true)
      expect(getSelection()!.getRangeAt(0)).toBe(range)
      expect(range.startContainer).toBe(text)
      expect(getSelection()!.toString()).toBe('Selectable')
      await act(async () => useAppStore.setState({ viewModes: { [control.agentSessionId]: 'activity' } }))
      await wait(() => expect(sample(control).loading).toBe(false))
      await act(async () => useAppStore.setState({ viewModes: { [control.agentSessionId]: 'terminal' } }))
      await openAgentHistory(host)
      await wait(() => expect(sample(control).loading).toBe(false))
      expect(text.isConnected).toBe(true)
      expect(traces()[0]).toBe(trace)
      expect(isTraceOpen(trace)).toBe(true)
      expect(getSelection()!.getRangeAt(0)).toBe(range)
      expect(nativeRead).toHaveBeenCalledTimes(count)
      expect(historyPageSpy).not.toHaveBeenCalled()
    },
  )

  it('hiding an in-flight initial actual Activity read rejects its late frame and reopens the original source', async () => {
    const f = await fixture([native('hidden-stale-page')]),
      held = holdNextRead()
    await f.render()
    await wait(() => expect(held.entered()).toBe(true))
    await f.render(false)
    await act(async () => held.release())
    await wait(() => expect(held.returned()).toBe(true))
    expect(host.textContent).not.toContain('Message body for hidden-stale-page')
    await f.render()
    await wait(() => {
      expect(nativeIds()).toEqual(['hidden-stale-page'])
      expect(sample().loading).toBe(false)
    })
  })
  it('a new original reading generation supersedes pending Earlier without accepting its late frame or getting stuck', async () => {
    const f = await fixture(Array.from({ length: 150 }, (_, index) => native('original-' + index)))
    await f.render()
    await earlierReady()
    const held = holdNextRead((input) => Boolean(input.cursor))
    await click('Earlier')
    await wait(() => expect(held.entered()).toBe(true))
    await f.render(true, 'new-reading-generation')
    await wait(() => {
      expect(sample().loading).toBe(false)
      expect(sample().readingIdentity).toBe('new-reading-generation')
    })
    const accepted = sample().accepted!,
      ids = nativeIds()
    await act(async () => held.release())
    await wait(() => expect(held.returned()).toBe(true))
    expect(nativeIds()).toEqual(ids)
    expect(sample().accepted!.id).toBe(accepted.id)
    await wait(() => expect(sample()).toMatchObject({ loading: false, inFlight: false, dirty: false, error: null }))
    expect(nativeIds()).toEqual(ids)
    expect(sample().accepted!.id).toBe(accepted.id)
  })
  it.each(['single-row', 'cross-row'] as const)(
    'non-destructive Earlier preserves the actual %s Range and original newest body',
    async (shape) => {
      const f = await fixture(Array.from({ length: 250 }, (_, index) => native('original-' + index)))
      await f.render()
      await earlierReady()
      const newest = turn('original-249'),
        lastText = newest.querySelector('.log-turn__body p')!.firstChild!
      const firstText =
        shape === 'cross-row' ? turn('original-248').querySelector('.log-turn__body p')!.firstChild! : lastText
      const range = document.createRange()
      range.setStart(firstText, 2)
      range.setEnd(lastText, 8)
      getSelection()!.addRange(range)
      const originalText = getSelection()!.toString(),
        held = holdNextRead((input) => Boolean(input.cursor))
      const token = vi.mocked(api.conversation.readAgentConversation).mock.calls.at(-1)![0]
      expect(token.cursor).toBeUndefined()
      await click('Earlier')
      await wait(() => expect(held.entered()).toBe(true))
      await act(async () => held.release())
      await wait(() => {
        expect(nativeIds()).toHaveLength(200)
        expect(sample().loading).toBe(false)
      })
      expect(turn('original-249')).toBe(newest)
      expect(firstText.isConnected).toBe(true)
      expect(lastText.isConnected).toBe(true)
      expect(getSelection()!.getRangeAt(0)).toBe(range)
      expect(range.startContainer).toBe(firstText)
      expect(range.endContainer).toBe(lastText)
      expect(getSelection()!.toString()).toBe(originalText)
    },
  )
  it('a cross-row Range whose end is in a removed newest record holds that exact original body until selection clears', async () => {
    const older = native('p1'),
      newest = native('p0'),
      f = await fixture([older, newest])
    await f.draw()
    const first = turn('p1').querySelector('.log-turn__body p')!.firstChild!,
      last = turn('p0').querySelector('.log-turn__body p')!.firstChild!,
      card = turn('p0')
    const range = document.createRange()
    range.setStart(first, 2)
    range.setEnd(last, 8)
    getSelection()!.addRange(range)
    const quote = getSelection()!.toString()
    f.replace([older])
    await f.draw()
    expect(nativeIds()).toEqual(['p1', 'p0'])
    expect(card.isConnected).toBe(true)
    expect(last.isConnected).toBe(true)
    expect(getSelection()!.getRangeAt(0)).toBe(range)
    expect(range.startContainer).toBe(first)
    expect(range.endContainer).toBe(last)
    expect(getSelection()!.toString()).toBe(quote)
    await act(async () => {
      getSelection()!.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    await f.draw()
    expect(nativeIds()).toEqual(['p1'])
  })
  it('a pointer-targeted actual Earlier read restores the original body at its exact 20px viewport offset', async () => {
    const f = await fixture(Array.from({ length: 150 }, (_, index) => native('original-' + index)))
    await f.render()
    await earlierReady()
    const view = geometry(),
      { feed } = view,
      original = turn('original-149'),
      held = holdNextRead((input) => Boolean(input.cursor))
    const addedHeight = () => (turnLoaded('original-0') ? 100 : 0)
    Object.defineProperty(feed, 'scrollHeight', { configurable: true, get: () => 1000 + addedHeight() })
    feed.getBoundingClientRect = () => new DOMRect(0, 10, 500, 400)
    feed.querySelector<HTMLElement>('[data-conversation-reading-tail]')!.getBoundingClientRect = () =>
      new DOMRect(0, 10 + 1000 + addedHeight() - feed.scrollTop, 500, 0)
    original.getBoundingClientRect = () =>
      new DOMRect(0, 30 + addedHeight() - feed.scrollTop, 500, 40)
    await view.scroll(600)
    await view.scroll(0)
    await act(async () => {
      for (const observer of intersections)
        if (observer.targets.has(original))
          observer.deliver([
            {
              target: original,
              isIntersecting: true,
              intersectionRatio: 1,
              time: 0,
              rootBounds: feed.getBoundingClientRect(),
              boundingClientRect: original.getBoundingClientRect(),
              intersectionRect: original.getBoundingClientRect(),
            },
          ])
    })
    await act(async () => original.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    await act(async () => original.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })))
    await wait(() => expect(held.entered()).toBe(true))
    expect(feed.scrollTop).toBe(0)
    expect(original.getBoundingClientRect().top - feed.getBoundingClientRect().top).toBe(20)
    await act(async () => held.release())
    await wait(() => {
      expect(nativeIds()).toHaveLength(150)
      expect(sample().loading).toBe(false)
    })
    expect(feed.scrollTop).toBe(100)
    expect(original.getBoundingClientRect().top - feed.getBoundingClientRect().top).toBe(20)
  })
  it('a real Earlier failure preserves its accepted frame and Retry repeats the original navigation token', async () => {
    const f = await fixture(Array.from({ length: 150 }, (_, index) => native('original-' + index)))
    await f.render()
    await earlierReady()
    const read = vi.mocked(api.conversation.readAgentConversation),
      original = read.getMockImplementation()!,
      before = sample().accepted!,
      newest = turn('original-149')
    let failedCursor: string | undefined,
      fail = true
    read.mockImplementation((input, options) => {
      if (input.cursor && fail) {
        failedCursor = input.cursor
        return Promise.reject(new Error('Network timeout loading older page'))
      }
      return original(input, options)
    })
    await click('Earlier')
    await wait(() => expect(host.textContent).toContain('Network timeout loading older page'))
    expect(sample().accepted).toMatchObject({ id: before.id, revision: before.revision })
    expect(turn('original-149')).toBe(newest)
    expect(failedCursor).toBeTruthy()
    fail = false
    const count = read.mock.calls.length
    const retries = host.querySelectorAll<HTMLButtonElement>('[aria-label="Retry reading"]')
    expect(retries).toHaveLength(1)
    await act(async () => retries[0]!.click())
    await wait(() => {
      expect(nativeIds()).toHaveLength(150)
      expect(sample().loading).toBe(false)
    })
    expect(read.mock.calls.slice(count).some(([input]) => input.cursor === failedCursor)).toBe(true)
    expect(f.nativeRead.mock.calls.at(-1)![1]!.cursor).toBe('original:50')
  })
  it('actual captured append respects upward reading, and explicit loaded-tail navigation restores follow', async () => {
    const f = await fixture([])
    await f.publishCaptured([
      {
        id: 'first',
        agentSessionId: controlA.agentSessionId,
        kind: 'user_message',
        source: 'user',
        status: 'complete',
        title: 'First',
        content: 'First message',
        createdAt: 1000,
        updatedAt: 1000,
      },
    ])
    await f.render()
    await wait(() => expect(sample().accepted?.recordCount).toBe(1))
    const view = geometry()
    await view.scroll(600)
    await view.scroll(10)
    const stream = await f.publishCaptured([
      {
        id: 'second',
        agentSessionId: controlA.agentSessionId,
        kind: 'user_message',
        source: 'user',
        status: 'complete',
        title: 'Second',
        content: 'Second message',
        createdAt: 2000,
        updatedAt: 2000,
      },
    ])
    await wait(() => expect(f.acceptedCaptured(stream)).toBe(true))
    expect(view.feed.scrollTop).toBe(10)
    expect(host.querySelector('[data-message-tool-control="jump-to-latest"]')).not.toBeNull()
    const nativeReads = f.nativeRead.mock.calls.length
    await click('滚动到最新')
    expect(view.feed.scrollTop).toBe(600)
    expect(host.querySelector('[data-message-tool-control="jump-to-latest"]')).toBeNull()
    expect(f.nativeRead).toHaveBeenCalledTimes(nativeReads)
  })
  it('switching original Session resets detached follow and does not attribute the old window to the new Session', async () => {
    const a = await fixture([native('a-1')])
    await a.render()
    await wait(() => expect(nativeIds()).toEqual(['a-1']))
    const view = geometry()
    await view.scroll(600)
    await view.scroll(20)
    expect(host.querySelector('[data-message-tool-control="jump-to-latest"]')).not.toBeNull()
    const b = await fixture([native('b-1')], controlB)
    await b.render()
    await wait(() => {
      expect(nativeIds()).toEqual(['b-1'])
      expect(sample(controlB).loading).toBe(false)
    })
    expect(host.querySelector('[data-message-tool-control="jump-to-latest"]')).toBeNull()
    expect(sample(controlB).accepted!.scope.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'native', nativeSessionId: nativeSource.nativeSessionId }),
      ]),
    )
    expect(host.textContent).not.toContain('Message body for a-1')
  })
  it('an actual empty accepted frame gains captured content without losing later upward intent', async () => {
    const f = await fixture([])
    await f.render()
    await wait(() => expect(sample().accepted?.recordCount).toBe(0))
    const append = async (id: string, at: number) =>
      f.publishCaptured([
        {
          id,
          agentSessionId: controlA.agentSessionId,
          kind: 'user_message',
          source: 'user',
          status: 'complete',
          title: id,
          content: id,
          createdAt: at,
          updatedAt: at,
        },
      ])
    const first = await append('First message', 1000)
    await wait(() => expect(f.acceptedCaptured(first)).toBe(true))
    const view = geometry()
    await view.scroll(600)
    await view.scroll(20)
    const second = await append('Second message', 2000)
    await wait(() => expect(f.acceptedCaptured(second)).toBe(true))
    expect(view.feed.scrollTop).toBe(20)
    expect(sample().accepted?.recordCount).toBe(2)
    expect(host.querySelector('[data-message-tool-control="jump-to-latest"]')).not.toBeNull()
  })

  it('actual public frames preserve an original selection and expanded trace when an older contribution is prepended', async () => {
    const original = native('msg-1', [call('call-1', 'echo hello'), body('Original paragraph with selectable text.')]),
      f = await fixture([original])
    await f.draw()
    const trace = traces()[0]!
    expect(trace).toBeDefined()
    await act(async () => openTrace(trace))
    const text = turn('msg-1').querySelector('.log-turn__body p')!.firstChild!,
      range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 8)
    getSelection()!.addRange(range)
    f.replace([native('msg-older'), original])
    await f.draw()
    expect(nativeIds()).toEqual(['msg-older', 'msg-1'])
    expect(traces().at(-1)).toBe(trace)
    expect(isTraceOpen(trace)).toBe(true)
    expect(text.isConnected).toBe(true)
    expect(getSelection()!.getRangeAt(0)).toBe(range)
    expect(getSelection()!.toString()).toBe('Original')
  })
  it('duplicate part references and call IDs render through real public frames without React key collisions', async () => {
    const duplicate: AgentSessionHistoryContentPart = { kind: 'reasoning', text: 'duplicate reasoning' },
      errors: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args))
    const f = await fixture([
      native('msg-dup', [duplicate, duplicate, call('shared-id', '1'), call('shared-id', '2'), body('Original body')]),
    ])
    await f.draw()
    expect(traces()).toHaveLength(4)
    expect(errors.filter((args) => /same key|unique "key"/u.test(String(args[0])))).toHaveLength(0)
  })
  it('does not re-parse Markdown during actual copy, selection and annotation-editor keystrokes', async () => {
    const blocks = vi.spyOn(markdown, 'parseAgentMarkdown'),
      documentParser = vi.spyOn(markdown, 'parseAgentMarkdownDocument')
    const parses = () => blocks.mock.calls.length + documentParser.mock.calls.length
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    const selectionRect = new DOMRect(20, 80, 120, 18)
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(selectionRect)
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() =>
      Object.assign([selectionRect], { item: (index: number) => (index === 0 ? selectionRect : null) }),
    )
    const content = '**body text** ' + 'prose '.repeat(50)
    await act(async () =>
      root.render(
        <ConversationAnnotationOwner onAnnotate={vi.fn()}>
          {(onSelectAnnotation) => (
            <ConversationMessage messageId="msg-memo-test" content={content} onSelectAnnotation={onSelectAnnotation} />
          )}
        </ConversationAnnotationOwner>,
      ),
    )
    const initialParses = parses()
    expect(initialParses).toBeGreaterThan(0)
    const copy = host.querySelector<HTMLButtonElement>('[title="Copy message"]')!
    expect(copy).not.toBeNull()
    await act(async () => copy.click())
    expect(parses()).toBe(initialParses)
    const text = host.querySelector('strong')!.firstChild!,
      range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 4)
    getSelection()!.addRange(range)
    await act(async () =>
      host.querySelector('.log-turn__text')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })),
    )
    await wait(() => expect(document.querySelector('[role="toolbar"]')).not.toBeNull())
    expect(parses()).toBe(initialParses)
    const annotate = [...document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')].find(
      (button) => button.textContent?.trim() === '批注',
    )!
    expect(annotate).toBeDefined()
    await act(async () => annotate.click())
    await wait(() => expect(document.querySelector('.log-turn__annotation textarea')).not.toBeNull())
    const textarea = document.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')!
    for (const value of ['a', 'ab', 'abc']) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(parses()).toBe(initialParses)
    }
    expect(textarea.value).toBe('abc')
    expect(text.isConnected).toBe(true)
    expect(range.startContainer).toBe(text)
  })

  it('deserialized current public frames retain unchanged reasoning and tool disclosure', async () => {
    const parts: AgentSessionHistoryContentPart[] = [
      { kind: 'reasoning', text: 'private unchanged reasoning' },
      call('stable-positive-tool'),
      body('Same body'),
    ]
    const f = await fixture([native('stable-record', parts)])
    await f.draw()
    const before = traces()
    expect(before).toHaveLength(2)
    await act(async () => before.forEach(openTrace))
    f.replace([native('stable-record', structuredClone(parts))])
    await f.draw()
    expect(traces()).toEqual(before)
    expect(traces().map(isTraceOpen)).toEqual([true, true])
  })
  it.each(['older', 'latest'] as const)(
    'hidden/reopen after pending %s clears loading and retains usable original controls',
    async (direction) => {
      const f = await fixture(Array.from({ length: 150 }, (_, index) => native('kept-' + index)))
      await f.render()
      await earlierReady()
      const before = nativeIds(),
        held = holdNextRead(
          direction === 'older' ? (input) => Boolean(input.cursor) : (input) => !input.cursor && !input.view,
        )
      if (direction === 'older') await click('Earlier')
      else await f.render(true, 'explicit-generation')
      await wait(() => expect(held.entered()).toBe(true))
      await f.render(false, direction === 'older' ? controlA.run.runId : 'explicit-generation')
      await act(async () => held.release())
      await wait(() => expect(held.returned()).toBe(true))
      expect(nativeIds()).toEqual(before)
      await f.render(true, direction === 'older' ? controlA.run.runId : 'explicit-generation')
      await wait(() => expect(sample().loading).toBe(false))
      expect(action('Earlier').disabled).toBe(false)
      expect(sample().error).toBeNull()
    },
  )
  it('tool call/result sharing callId never cross-expand across original rows or original Hosts', async () => {
    const items = [
      native('msg-with-shared-id', [
        call('shared-call-id', 'command 1'),
        { kind: 'tool-result', name: 'shell', callId: 'shared-call-id', output: 'output 1' },
        body('row one'),
      ]),
      native('msg-2-shared-id', [call('shared-call-id', 'command 2'), body('row two')]),
    ]
    const local = await fixture(items)
    await local.draw()
    expect(traces()).toHaveLength(3)
    await act(async () => openTrace(traces()[0]!))
    await local.draw()
    expect(traces().map(isTraceOpen)).toEqual([true, false, false])
    const remote = await fixture(items, { ...controlA, hostId: 'remote' })
    await remote.draw()
    expect(traces().map(isTraceOpen)).toEqual([false, false, false])
  })
  it.each([
    { ids: ['native:record', 'native:record:tool-call:x'], calls: ['x:tool-call:y', 'y'] },
    { ids: ['native:inner-record'], calls: ['x', 'x', 'x:0'] },
  ])(
    'opaque tuple and repeated call IDs keep independent disclosure and no key collisions: $calls',
    async ({ ids, calls }) => {
      const errors: unknown[][] = []
      vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args))
      const items =
        ids.length === 1
          ? [native(ids[0]!, [...calls.map((id, index) => call(id, String(index))), body('Original body')])]
          : ids.map((id, index) => native(id, [call(calls[index]!, String(index)), body('Original body ' + index)]))
      const f = await fixture(items)
      await f.draw()
      const before = traces()
      expect(before).toHaveLength(calls.length)
      const traceIds = before.map((trace) => trace.dataset.traceId)
      expect(traceIds.every(Boolean)).toBe(true)
      expect(new Set(traceIds).size).toBe(calls.length)
      await act(async () => openTrace(before[0]!))
      await f.draw()
      expect(traces().map(isTraceOpen)).toEqual(calls.map((_, index) => index === 0))
      expect(errors.filter((args) => /same key|unique "key"/u.test(String(args[0])))).toHaveLength(0)
    },
  )
  it('two real SessionPane Regions for the same original control own independent trace disclosure', async () => {
    const f = await fixture([native('native:inner-record', [call('call-one'), body('Selectable true native body')])])
    const session = nativeParentSession(f.workspacePath, f.actualControl)
    useAppStore.setState({ sessions: [session], viewModes: { [controlA.agentSessionId]: 'activity' } })
    const draw = () =>
      root.render(
        <>
          <div data-region="left">
            <SessionPane
              sessionId={controlA.agentSessionId}
              surfaceKind="agent"
              interactiveResize={false}
              visible
              readOnly
              linkOrigin={{ workspaceId: 'w', tabGroupId: 'g', tabId: 'left-tab', regionId: 'left' }}
            />
          </div>
          <div data-region="right">
            <SessionPane
              sessionId={controlA.agentSessionId}
              surfaceKind="agent"
              interactiveResize={false}
              visible
              readOnly
              linkOrigin={{ workspaceId: 'w', tabGroupId: 'g', tabId: 'right-tab', regionId: 'right' }}
            />
          </div>
        </>,
      )
    await act(async () => draw())
    await wait(() => {
      expect(traces(host.querySelector('[data-region="left"]')!)).toHaveLength(1)
      expect(traces(host.querySelector('[data-region="right"]')!)).toHaveLength(1)
    })
    const left = traces(host.querySelector('[data-region="left"]')!)[0]!,
      right = traces(host.querySelector('[data-region="right"]')!)[0]!
    await act(async () => openTrace(left))
    expect(isTraceOpen(left)).toBe(true)
    expect(isTraceOpen(right)).toBe(false)
    await act(async () => useAppStore.setState({ sessions: [{ ...session, label: 'Renamed Parent' }] }))
    expect(traces(host.querySelector('[data-region="left"]')!)[0]).toBe(left)
    expect(isTraceOpen(left)).toBe(true)
    expect(isTraceOpen(right)).toBe(false)
  })
  it('adding a later same-callId part retains the unchanged original trace and starts only the new trace closed', async () => {
    const part = call('x', 'initial'),
      f = await fixture([native('native:append-record', [part, body('body initial')])])
    await f.draw()
    const first = traces()[0]!
    await act(async () => openTrace(first))
    f.replace([native('native:append-record', [part, call('x', 'appended duplicate'), body('body initial')])])
    await f.draw()
    expect(traces()).toHaveLength(2)
    expect(traces()[0]).toBe(first)
    expect(traces().map(isTraceOpen)).toEqual([true, false])
  })
  it('a real public current frame prunes only absent opaque records and preserves overlapping-prefix disclosure and selected original bytes', async () => {
    const ids = ['native:record', 'native:record:tool-call:x'],
      items = ids.map((id, index) =>
        native(id, [call(index ? 'y' : 'x:tool-call:y'), body('Selectable original body ' + index)]),
      )
    const f = await fixture(items)
    await f.draw()
    await act(async () => traces().forEach(openTrace))
    const retained = traces()[1]!,
      text = turn(ids[1]!).querySelector('.log-turn__body p')!.firstChild!,
      range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 10)
    getSelection()!.addRange(range)
    f.replace([items[1]!])
    await f.draw()
    expect(nativeIds()).toEqual([ids[1]])
    expect(traces()[0]).toBe(retained)
    expect(isTraceOpen(retained)).toBe(true)
    expect(text.isConnected).toBe(true)
    expect(getSelection()!.getRangeAt(0)).toBe(range)
    expect(getSelection()!.toString()).toBe('Selectable')
    f.replace(items)
    await f.draw()
    expect(nativeIds()).toEqual(ids)
    expect(traces().map(isTraceOpen)).toEqual([false, true])
    expect(text.isConnected).toBe(true)
    expect(range.startContainer).toBe(text)
  })
})
function turnLoaded(id: string) {
  return [...host.querySelectorAll<HTMLElement>('[data-native-record-id]')].some(
    (row) => row.dataset.nativeRecordId === id,
  )
}
