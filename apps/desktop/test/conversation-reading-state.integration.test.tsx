const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionControl, SessionHistoryReference, SessionSnapshot } from '../src/shared/contracts'

import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { agentHistoryMenuEntry, openAgentHistory } from './helpers/agent-history-menu'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { ConversationAnnotationOwner } from './helpers/conversation-annotation-owner'
import * as markdown from '@agentmux/client-ui/agent-markdown'

const observation = vi.hoisted(() => ({ enabled: false, refresh: vi.fn<() => Promise<void>>() }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ visible = true, onObservationRefresh }: {
    visible?: boolean; onObservationRefresh?: (refresh: (() => Promise<void>) | null) => void
  }) => {
    useEffect(() => {
      if (!observation.enabled) return
      onObservationRefresh?.(observation.refresh)
      return () => onObservationRefresh?.(null)
    }, [onObservationRefresh])
    return <div className="terminal-view" data-visible={visible}>Retained terminal surface</div>
  }
}))

type TraceElement = HTMLDetailsElement | HTMLButtonElement
const TRACE_SELECTOR = 'details.log-turn__trace[data-trace-kind="reasoning"], button.conversation-tool-trace__row'
function isTraceOpen(el: TraceElement): boolean {
  return el.tagName === 'DETAILS' ? (el as HTMLDetailsElement).open : el.getAttribute('aria-expanded') === 'true'
}
function openTrace(el: TraceElement): void {
  if (el.tagName === 'DETAILS') {
    expect(el.dataset.traceKind).toBe('reasoning')
    ;(el as HTMLDetailsElement).open = true
    el.dispatchEvent(new Event('toggle'))
  } else {
    expect(el.classList.contains('conversation-tool-trace__row')).toBe(true)
    expect(el.getAttribute('aria-expanded')).toBe('false')
    el.click()
  }
}

const controlA: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'session-reading-a',
  run: { runId: 'run-a' }
}

const controlB: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'session-reading-b',
  run: { runId: 'run-b' }
}

function makePage(
  id: string,
  nextCursor: string | null = null,
  sessionId = controlA.agentSessionId,
  parts?: AgentSessionHistoryContentPart[]
): AgentSessionHistoryPage {
  return {
    agentSessionId: sessionId,
    source: { providerId: 'codex', nativeSessionId: `native-${sessionId}` },
    items: [
      {
        id,
        kind: 'assistant-message',
        contentParts: parts ?? [{ kind: 'text', text: `Message body for ${id}` }]
      }
    ],
    nextCursor
  }
}

function makeTimelineItem(id: string, sessionId = controlA.agentSessionId, text = 'Live message'): AgentTimelineItem {
  return {
    id,
    agentSessionId: sessionId,
    kind: 'assistant_message',
    status: 'complete',
    source: 'native-hook',
    createdAt: 1000,
    updatedAt: 1000,
    title: 'Assistant',
    content: text
  }
}

// A controlled producer file goes through the public FileStore/Provider reader. IPC delegates
// that real promise; it never fabricates native pages or controls a live Run.
async function withPublicNativeHistory(
  ids: readonly string[],
  verify: (fixture: { pages: AgentSessionHistoryPage[]; replaceRecords(ids: readonly string[]): Promise<void>; workspacePath: string; flush(): Promise<void> }) => Promise<void>
): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 't028-owned-native-'))
  const nativePath = join(workspacePath, 'native.jsonl')
  const storePath = join(workspacePath, 'agent-sessions.json')
  const nativeSessionId = 'private-reading-quality-native'
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  let expectedNative = ''
  async function replaceRecords(recordIds: readonly string[]): Promise<void> {
    await writeFile(nativePath, recordIds.map(uuid => JSON.stringify({
      sessionId: nativeSessionId, uuid, type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: ids.indexOf(uuid) === 0 ? 'x:tool-call:y' : 'y', name: 'sh', input: { command: `private native ${uuid}` } },
        { type: 'text', text: `Selectable native body ${uuid}` }
      ] }
    })).join('\n') + '\n')
    expectedNative = digest(await readFile(nativePath))
  }
  await replaceRecords(ids)
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: controlA.agentSessionId, providerId: 'claude', executorId: 'claude', hostId: controlA.hostId,
    workspacePath, run: controlA.run, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-reading-binding', hookToken: 'private-reading-token',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: nativeSessionId, transcriptPath: nativePath }
  })
  const expectedStore = digest(await readFile(storePath))
  const client = new AgentMuxClient({ store })
  // Only observe the actual private adapter for zero-control assertions; no product debug API.
  const kernel = Reflect.get(client, 'kernel')
  const monitored = ['start', 'input', 'resize', 'stop', 'attach', 'status'] as const
  const controls = monitored.map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error(`History must not control private fixture Run: ${name}`) }))
  const pages: AgentSessionHistoryPage[] = []
  const pending: Promise<AgentSessionHistoryPage>[] = []
  historyPageSpy.mockImplementation(async (control: SessionHistoryReference, options) => {
    expect(control).toEqual(controlA)
    const read = client.sessionHistoryPage(control.agentSessionId, options)
    pending.push(read)
    const page = await read
    expect(page.agentSessionId).toBe(controlA.agentSessionId)
    expect(page.source).toEqual({ providerId: 'claude', nativeSessionId })
    expect(page.items.length).toBeGreaterThan(0)
    pages.push(page)
    return page
  })
  try {
    await verify({ pages, replaceRecords, workspacePath, flush: async () => { await Promise.all(pending) } })
    expect(pages.length).toBeGreaterThan(0)
    expect(monitored).toEqual(['start', 'input', 'resize', 'stop', 'attach', 'status'])
    expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
    expect(digest(await readFile(nativePath))).toBe(expectedNative)
    expect(digest(await readFile(storePath))).toBe(expectedStore)
  } finally {
    await act(async () => root.unmount())
    root = createRoot(host)
    for (const spy of controls) spy.mockRestore()
    await client.dispose()
  }
}

function nativeParentSession(workspacePath: string): SessionSnapshot {
  return {
    kind: 'agent', id: controlA.agentSessionId, hostId: controlA.hostId, control: controlA,
    label: 'Private native parent', providerId: 'claude', executorId: 'claude', workspacePath,
    createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0, processState: 'running',
    status: { state: 'done', source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' }
  }
}

async function mountNativeParent(workspacePath: string): Promise<void> {
  useAppStore.setState({ sessions: [nativeParentSession(workspacePath)],
    config: { appearance: { terminalTheme: 'graphite', terminalFontSize: 12 }, workspaces: [], hosts: [], executors: {} } as any,
    viewModes: { [controlA.agentSessionId]: 'terminal' }
  })
  await act(async () => root.render(<SessionPane sessionId={controlA.agentSessionId} surfaceKind="agent" interactiveResize={false}
    visible={true} readOnly={true} linkOrigin={{ workspaceId: 'w', tabGroupId: 'g', tabId: 't', regionId: 'native-quality-region' }} />))
  expect(historyPageSpy).toHaveBeenCalledTimes(0)
  await openAgentHistory(host)
}

let host: HTMLDivElement
let root: Root
let historyPageSpy: MockInstance<typeof api.sessions.historyPage>
let clipboardSpy: MockInstance<typeof api.ui.writeClipboardText>

beforeEach(() => {
  vi.clearAllMocks()
  observation.enabled = false
  observation.refresh.mockReset()
  useAppStore.setState({ error: null, lastError: null, errorNoticeContext: null, errorDismissed: false })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  historyPageSpy = vi.spyOn(api.sessions, 'historyPage')
  clipboardSpy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.getSelection()?.removeAllRanges()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  historyPageSpy.mockRestore()
  clipboardSpy.mockRestore()
})

describe('T028 Conversation Reading State and Pagination Lifecycle', () => {
  it('preserves the actual Header Portal and Header/Lifecycle observation refresh ownership and busy state across read-only presentation', async () => {
    observation.enabled = true
    const originalRefresh = useAppStore.getState().refreshSession
    const originalRecover = useAppStore.getState().recoverSession
    const refreshSession = vi.fn().mockResolvedValue(undefined)
    const recoverSession = vi.fn().mockResolvedValue(undefined)
    let release!: () => void
    observation.refresh.mockImplementation(() => new Promise<void>(done => { release = done }))
    const portal = document.createElement('div'); portal.id = 'private-t028-header-portal'; document.body.append(portal)
    useAppStore.setState({ sessions: [nativeParentSession(_hygiene_fixturePath("private-observation"))],
      config: { appearance: { terminalTheme: 'graphite', terminalFontSize: 12 }, workspaces: [], hosts: [], executors: {} } as any,
      viewModes: { [controlA.agentSessionId]: 'terminal' }, refreshSession, recoverSession,
      error: 'Private retained observation failure', errorNoticeContext: { kind: 'indeterminate',
        lifecycle: { step: 'resume', subject: controlA, lastProcessState: 'running' } }
    })
    const render = (readOnly: boolean) => root.render(<SessionPane sessionId={controlA.agentSessionId} surfaceKind="agent"
      interactiveResize={false} visible readOnly={readOnly} headerPortalTargetId={portal.id}
      linkOrigin={{ workspaceId: 'w', tabGroupId: 'g', tabId: 't', regionId: 'private-observation-region' }} />)
    try {
      await act(async () => render(false))
      expect(portal.querySelectorAll('.agent-region-header')).toHaveLength(1)
      expect(host.querySelectorAll('.agent-region-header')).toHaveLength(0)
      await agentHistoryMenuEntry(portal)
      const headerRefresh = [...document.querySelectorAll<HTMLElement>('.agent-region-menu [role="menuitem"]')]
        .find(item => item.textContent?.trim() === 'Refresh observation')
      expect(headerRefresh).toBeDefined()
      await act(async () => headerRefresh!.click())
      // Radix returns focus on the next browser task after selection. Finish that task
      // before simulating a second keyboard gesture in the same happy-dom turn.
      await act(async () => { await new Promise<void>(done => setTimeout(done, 0)) })
      expect(observation.refresh).toHaveBeenCalledTimes(1)
      const lifecycleButtons = [...host.querySelectorAll<HTMLButtonElement>('.agent-launch-notice button')]
        .filter(button => button.textContent === 'Refresh observation' || button.textContent === 'Retry Resume')
      expect(lifecycleButtons.map(button => button.textContent)).toEqual(['Refresh observation', 'Retry Resume'])
      expect(lifecycleButtons.map(button => button.disabled)).toEqual([true, true])
      await agentHistoryMenuEntry(portal)
      const busyRefresh = [...document.querySelectorAll<HTMLElement>('.agent-region-menu [role="menuitem"]')]
        .find(item => item.textContent?.trim() === 'Refreshing observation…')
      expect(busyRefresh).toBeDefined()
      expect(busyRefresh!.getAttribute('aria-disabled')).toBe('true')
      await act(async () => release())
      expect(lifecycleButtons.map(button => button.disabled)).toEqual([false, false])
      await act(async () => render(true))
      expect(portal.querySelectorAll('.agent-region-header')).toHaveLength(0)
      expect(host.querySelectorAll('.agent-region-header')).toHaveLength(1)
      const lifecycleRefresh = [...host.querySelectorAll<HTMLButtonElement>('.agent-launch-notice button')]
        .find(button => button.textContent === 'Refresh observation')
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
      await act(async () => root.unmount()); root = createRoot(host)
      portal.remove(); useAppStore.setState({ refreshSession: originalRefresh, recoverSession: originalRecover })
    }
  })















  it('ActivityView: reading old messages does not scroll to bottom on new message append, explicit jump restores follow', async () => {
    const items = [
      makeTimelineItem('m-1', controlA.agentSessionId, 'First message'),
      makeTimelineItem('m-2', controlA.agentSessionId, 'Second message')
    ]

    await act(async () =>
      root.render(
        <ActivityView
          sessionId={controlA.agentSessionId}
          items={items}
          capability="complete-events"
          displayState="done"
          workspaceRoot={_hygiene_fixturePath("test")}
        />
      )
    )

    const feed = host.querySelector<HTMLDivElement>('.activity-feed')!
    expect(feed).not.toBeNull()

    // Simulate initial bottom position
    Object.defineProperty(feed, 'scrollTop', { value: 600, writable: true })
    Object.defineProperty(feed, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(feed, 'clientHeight', { value: 400, writable: true })
    await act(async () => feed.dispatchEvent(new Event('scroll')))

    // User scrolls up to read older messages (scrollTop drops from 600 to 10)
    feed.scrollTop = 10
    await act(async () => feed.dispatchEvent(new Event('scroll')))

    // Jump to latest button must be shown
    const jumpBtnBefore = host.querySelector<HTMLButtonElement>('.activity-feed__jump')
    expect(jumpBtnBefore).not.toBeNull()

    // Append new item while detached
    const updatedItems = [
      ...items,
      makeTimelineItem('m-3', controlA.agentSessionId, 'Third appended message')
    ]
    await act(async () =>
      root.render(
        <ActivityView
          sessionId={controlA.agentSessionId}
          items={updatedItems}
          capability="complete-events"
          displayState="done"
          workspaceRoot={_hygiene_fixturePath("test")}
        />
      )
    )

    // Viewport should NOT have been pinned to bottom (scrollTop was 10, not 1000)
    expect(feed.scrollTop).toBe(10)
    expect(host.querySelector('.activity-feed__jump')).not.toBeNull()

    // Clicking Jump to latest pins to bottom and hides button
    const jumpBtn = host.querySelector<HTMLButtonElement>('.activity-feed__jump')!
    await act(async () => jumpBtn.click())
    expect(host.querySelector('.activity-feed__jump')).toBeNull()
  })

  it('ActivityView: switching session resets detached follow state and pins to bottom', async () => {
    const itemsA = [
      makeTimelineItem('a-1', controlA.agentSessionId, 'Session A item 1'),
      makeTimelineItem('a-2', controlA.agentSessionId, 'Session A item 2')
    ]

    await act(async () =>
      root.render(
        <ActivityView
          sessionId={controlA.agentSessionId}
          items={itemsA}
          capability="complete-events"
          displayState="done"
          workspaceRoot={_hygiene_fixturePath("test")}
        />
      )
    )

    const feed = host.querySelector<HTMLDivElement>('.activity-feed')!
    // Simulate initial bottom position then user scrolling up in Session A
    Object.defineProperty(feed, 'scrollTop', { value: 600, writable: true })
    Object.defineProperty(feed, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(feed, 'clientHeight', { value: 400, writable: true })
    await act(async () => feed.dispatchEvent(new Event('scroll')))
    feed.scrollTop = 20
    await act(async () => feed.dispatchEvent(new Event('scroll')))
    expect(host.querySelector('.activity-feed__jump')).not.toBeNull()

    // Switch to Session B items
    const itemsB = [
      makeTimelineItem('b-1', controlB.agentSessionId, 'Session B item 1')
    ]
    await act(async () =>
      root.render(
        <ActivityView
          sessionId={controlB.agentSessionId}
          items={itemsB}
          capability="complete-events"
          displayState="done"
          workspaceRoot={_hygiene_fixturePath("test")}
        />
      )
    )

    // Session B must NOT inherit Session A's detached state or jump button
    expect(host.querySelector('.activity-feed__jump')).toBeNull()
  })

  it('ActivityView: initial empty feed gains real content and then respects upward reading on append', async () => {
    // Initial empty items
    await act(async () =>
      root.render(
        <ActivityView
          sessionId={controlA.agentSessionId}
          items={[]}
          capability="complete-events"
          displayState="working"
          workspaceRoot={_hygiene_fixturePath("test")}
        />
      )
    )
    expect(host.textContent).toContain('Working')

    // Initial items arrive
    const items = [
      makeTimelineItem('first', controlA.agentSessionId, 'First message'),
      makeTimelineItem('second', controlA.agentSessionId, 'Second message')
    ]
    await act(async () =>
      root.render(
        <ActivityView
          sessionId={controlA.agentSessionId}
          items={items}
          capability="complete-events"
          displayState="done"
          workspaceRoot={_hygiene_fixturePath("test")}
        />
      )
    )

    const feed = host.querySelector<HTMLDivElement>('.activity-feed')!
    Object.defineProperty(feed, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(feed, 'clientHeight', { value: 400, writable: true })
    Object.defineProperty(feed, 'scrollTop', { value: 600, writable: true })
    await act(async () => feed.dispatchEvent(new Event('scroll')))

    // User scrolls up to 20
    feed.scrollTop = 20
    await act(async () => feed.dispatchEvent(new Event('scroll')))
    expect(host.querySelector('.activity-feed__jump')).not.toBeNull()

    // Third item appended
    const updated = [
      ...items,
      makeTimelineItem('third', controlA.agentSessionId, 'Third message')
    ]
    await act(async () =>
      root.render(
        <ActivityView
          sessionId={controlA.agentSessionId}
          items={updated}
          capability="complete-events"
          displayState="done"
          workspaceRoot={_hygiene_fixturePath("test")}
        />
      )
    )

    expect(host.querySelectorAll('.log-turn')).toHaveLength(3)
    // ScrollTop must stay at 20, not yanked to bottom
    expect(feed.scrollTop).toBe(20)
    expect(host.querySelector('.activity-feed__jump')).not.toBeNull()
  })





  it('does not re-parse Markdown during local copy or selection note keystrokes', async () => {
    const parser = vi.spyOn(markdown, 'parseAgentMarkdown')
    const content = '**body text** ' + 'prose '.repeat(50)

    await act(async () =>
      root.render(
        <ConversationAnnotationOwner onAnnotate={vi.fn()}>{onSelectAnnotation => <ConversationMessage
          messageId="msg-memo-test"
          content={content}
          onSelectAnnotation={onSelectAnnotation}
        />}</ConversationAnnotationOwner>
      )
    )

    const initialParses = parser.mock.calls.length
    expect(initialParses).toBeGreaterThan(0)

    // Copy message
    const copyBtn = host.querySelector<HTMLButtonElement>('[title="Copy message"]')!
    await act(async () => copyBtn.click())
    expect(parser.mock.calls.length).toBe(initialParses)

    // Select text
    const textNode = host.querySelector('strong')!.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 4)
    window.getSelection()!.addRange(range)
    await act(async () => host.querySelector('.log-turn__body')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(parser.mock.calls.length).toBe(initialParses)

    // Type in note textarea
    const textarea = host.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')
    if (textarea) {
      for (const char of ['a', 'b', 'c']) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, char)
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
        })
      }
    }
    expect(parser.mock.calls.length).toBe(initialParses)
    parser.mockRestore()
  })















  it('two SessionPane Regions for same control own independent trace disclosure', async () => {
    const sessionObj: SessionSnapshot = {
      id: controlA.agentSessionId,
      hostId: 'local',
      workspacePath: _hygiene_fixturePath("test"),
      label: 'Parent Agent',
      createdAt: 1000,
      updatedAt: 1000,
      agentSessionUpdatedAt: 1000,
      processState: 'running',
      status: { state: 'done', source: 'native-hook', observedAt: 1000 },
      latestOutputBytes: 0,
      kind: 'agent',
      providerId: 'codex',
      executorId: 'codex',
      control: controlA,
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' }
    }
    useAppStore.setState({
      sessions: [sessionObj],
      config: { appearance: { terminalTheme: 'graphite', terminalFontSize: 12 }, workspaces: [], hosts: [], executors: {} } as any,
      viewModes: { [controlA.agentSessionId]: 'terminal' }
    })

    const part: AgentSessionHistoryContentPart = { kind: 'tool-call', callId: 'call-multi', name: 'sh', input: 'echo test' }
    historyPageSpy.mockResolvedValue(makePage('multi-region-record', null, controlA.agentSessionId, [part]))

    const props = (regionId: string) => ({
      sessionId: controlA.agentSessionId,
      surfaceKind: 'agent' as const,
      interactiveResize: false,
      visible: true,
      readOnly: true,
      linkOrigin: { workspaceId: 'w', tabGroupId: 'g', tabId: 't', regionId }
    })

    await act(async () =>
      root.render(
        <div>
          <section data-region="left"><SessionPane {...props('left-reg')} /></section>
          <section data-region="right"><SessionPane {...props('right-reg')} /></section>
        </div>
      )
    )

    await openAgentHistory(host.querySelector('[data-region="left"]')!)
    await openAgentHistory(host.querySelector('[data-region="right"]')!)

    const left = host.querySelector<TraceElement>('[data-region="left"]')!.querySelector<TraceElement>(TRACE_SELECTOR)!
    const right = host.querySelector<TraceElement>('[data-region="right"]')!.querySelector<TraceElement>(TRACE_SELECTOR)!
    expect(left).not.toBeNull()
    expect(right).not.toBeNull()
    expect(isTraceOpen(left)).toBe(false)
    expect(isTraceOpen(right)).toBe(false)

    // Open trace on left only
    await act(async () => {
      openTrace(left)
    })
    expect(isTraceOpen(left)).toBe(true)
    expect(isTraceOpen(right)).toBe(false)

    // Trigger parent label re-render
    await act(async () => {
      useAppStore.setState({
        sessions: [{ ...sessionObj, label: 'Renamed Parent' }]
      })
    })

    const leftAfter = host.querySelector<TraceElement>('[data-region="left"]')!.querySelector<TraceElement>(TRACE_SELECTOR)!
    const rightAfter = host.querySelector<TraceElement>('[data-region="right"]')!.querySelector<TraceElement>(TRACE_SELECTOR)!
    expect(isTraceOpen(leftAfter)).toBe(true)
    expect(isTraceOpen(rightAfter)).toBe(false)
  })






})
