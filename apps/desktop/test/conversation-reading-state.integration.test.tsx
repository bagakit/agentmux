// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionControl, SessionSnapshot } from '../src/shared/contracts'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { agentHistoryMenuEntry, openAgentHistory } from './helpers/agent-history-menu'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import * as markdown from '../src/renderer/src/lib/agent-markdown'

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
  historyPageSpy.mockImplementation(async (control: AgentSessionControl, options) => {
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
    config: { appearance: { terminalTheme: 'graphite', terminalFontSize: 12 }, workspaces: [], executors: {} } as any,
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
    useAppStore.setState({ sessions: [nativeParentSession('/private-observation')],
      config: { appearance: { terminalTheme: 'graphite', terminalFontSize: 12 }, workspaces: [], executors: {} } as any,
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

  it('public native quoted and backslashed record IDs preserve selection when a fourth page cannot evict the newest reading page', async () => {
    const opaque = 'native:quoted"record\\tail'
    const ids = Array.from({ length: 121 }, (_, i) => i === 120 ? opaque : `native:opaque-page-${i}`)
    await withPublicNativeHistory(ids, async ({ pages, workspacePath, flush }) => {
      await mountNativeParent(workspacePath)
      await act(async () => await flush())
      const rows = () => [...host.querySelectorAll<HTMLElement>('[data-history-item-id]')]
      const loadEarlier = () => [...host.querySelectorAll<HTMLButtonElement>('.session-history__boundary button')]
        .find(button => button.textContent === 'Load earlier records')
      for (let i = 0; i < 2; i += 1) {
        expect(loadEarlier()).toBeDefined()
        await act(async () => { loadEarlier()!.click(); await flush() })
      }
      expect(rows()).toHaveLength(90)
      expect(pages.map(page => page.items.length)).toEqual([30, 30, 30])
      expect(pages[0]!.items.map(item => item.id)).toContain(opaque)
      const selectedRow = rows().find(row => row.dataset.historyItemId === opaque)
      expect(selectedRow).toBeDefined()
      const text = selectedRow!.querySelector('.log-turn__body p')!.firstChild!
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 'Selectable'.length)
      window.getSelection()!.addRange(range)
      const before = rows().map(row => row.dataset.historyItemId)
      expect(loadEarlier()).toBeDefined()
      await act(async () => { loadEarlier()!.click(); await flush() })
      expect(pages.map(page => page.items.length)).toEqual([30, 30, 30, 30])
      expect(rows().map(row => row.dataset.historyItemId)).toEqual(before)
      expect(host.textContent).toContain('Scroll toward the beginning before loading more history to preserve your reading position.')
      expect(host.textContent).not.toContain('not a valid selector')
      expect(text.isConnected).toBe(true)
      expect(window.getSelection()!.toString()).toBe('Selectable')
      expect(historyPageSpy).toHaveBeenCalledTimes(4)
    })
  })

  it('discards in-flight responses when SessionHistoryView is hidden, avoiding window pollution or stale errors', async () => {
    let resolveFirst!: (page: AgentSessionHistoryPage) => void
    historyPageSpy.mockImplementationOnce(
      () =>
        new Promise<AgentSessionHistoryPage>((done) => {
          resolveFirst = done
        })
    )

    // Mount initially visible
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )
    expect(historyPageSpy).toHaveBeenCalledTimes(1)

    // Now hide the view while read is pending
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={false}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    // The in-flight read resolves while view is hidden
    await act(async () => resolveFirst(makePage('hidden-stale-page')))

    // The hidden view should not have retained this stale page into state
    expect(host.textContent).not.toContain('Message body for hidden-stale-page')
  })

  it('allows Latest to supersede a pending slow older-page read without getting stuck', async () => {
    // 1. Mount with latest page
    historyPageSpy.mockResolvedValueOnce(makePage('page-latest', 'cursor-older-1'))
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )
    expect(host.textContent).toContain('Message body for page-latest')

    // 2. Start a pending older page read
    let resolveOlder!: (page: AgentSessionHistoryPage) => void
    historyPageSpy.mockImplementationOnce(
      () =>
        new Promise<AgentSessionHistoryPage>((done) => {
          resolveOlder = done
        })
    )
    const loadEarlierBtn = host.querySelector<HTMLButtonElement>('.session-history__boundary button')
    expect(loadEarlierBtn).not.toBeNull()
    await act(async () => loadEarlierBtn!.click())
    expect(historyPageSpy).toHaveBeenCalledTimes(2)

    // 3. While older read is pending, user clicks Latest button
    historyPageSpy.mockResolvedValueOnce(makePage('page-fresh-latest', null))
    const latestBtn = [...host.querySelectorAll<HTMLButtonElement>('.session-history__toolbar button')].find(
      (btn) => btn.textContent?.includes('Latest')
    )
    expect(latestBtn).toBeDefined()
    await act(async () => latestBtn!.click())

    // Latest read must have been sent to API, superseding older
    expect(historyPageSpy).toHaveBeenCalledTimes(3)
    expect(host.textContent).toContain('Message body for page-fresh-latest')

    // Now the older read resolves late
    await act(async () => resolveOlder(makePage('page-late-older', null)))

    // Late older page must NOT be prepended to the fresh latest window
    expect(host.textContent).not.toContain('Message body for page-late-older')
    expect(host.textContent).toContain('Message body for page-fresh-latest')
  })

  it('bounds the nearby window without throwing UI errors when loading older pages past capacity', async () => {
    historyPageSpy.mockResolvedValueOnce(makePage('p-latest', 'c-1'))
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    // Load page 2
    historyPageSpy.mockResolvedValueOnce(makePage('p-2', 'c-2'))
    const viewport = host.querySelector<HTMLDivElement>('.session-history__viewport')!
    viewport.scrollTop = 0
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))

    // Load page 3
    historyPageSpy.mockResolvedValueOnce(makePage('p-3', 'c-3'))
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))

    // Load page 4 (exceeding 3 pages capacity)
    historyPageSpy.mockResolvedValueOnce(makePage('p-4', 'c-4'))
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))

    // Must NOT throw UI error banner
    expect(host.querySelector('.session-history__notice')?.textContent ?? '').not.toContain('Scroll toward the beginning')
    expect(host.textContent).toContain('Newer records are outside this three-page reading window')
    const itemIds = Array.from(host.querySelectorAll<HTMLElement>('[data-history-item-id]'), (r) => r.dataset.historyItemId)
    expect(itemIds).toEqual(['p-4', 'p-3', 'p-2'])
  })

  it('fourth page eviction protects currently read latest item and active text selection', async () => {
    historyPageSpy.mockResolvedValueOnce(makePage('p0', 'c1'))
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    // Load page 1
    historyPageSpy.mockResolvedValueOnce(makePage('p1', 'c2'))
    const viewport = host.querySelector<HTMLDivElement>('.session-history__viewport')!
    viewport.scrollTop = 0
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))

    // Load page 2
    historyPageSpy.mockResolvedValueOnce(makePage('p2', 'c3'))
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))

    const rowsBefore = Array.from(host.querySelectorAll<HTMLElement>('[data-history-item-id]'), (r) => r.dataset.historyItemId)
    expect(rowsBefore).toEqual(['p2', 'p1', 'p0'])

    // Now start loading page 4 (p3)
    let resolveFourth!: (page: AgentSessionHistoryPage) => void
    historyPageSpy.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>((done) => { resolveFourth = done }))
    await act(async () => {
      viewport.scrollTop = 0
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    })

    // User scrolls down to read and select text in p0 while fourth page is in flight
    viewport.scrollTop = 250
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))

    const p0 = host.querySelector<HTMLElement>('[data-history-item-id="p0"]')!
    const textNode = p0.querySelector('.log-turn__body p')?.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 10)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    // Fourth page resolves
    await act(async () => resolveFourth(makePage('p3', 'c4')))

    // p0 must remain connected, text node connected, selection intact, and reading constraint shown
    expect(p0.isConnected).toBe(true)
    expect(textNode.isConnected).toBe(true)
    expect(sel.toString()).toBe('Message bo')
    expect(host.querySelector('.session-history__notice')?.textContent ?? '').toContain('Scroll toward the beginning')
  })

  it('preserves reading anchor through older-page loading even when user interacted with pointer or selection', async () => {
    historyPageSpy.mockResolvedValueOnce(makePage('initial-item', 'c-1'))
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    const viewport = host.querySelector<HTMLDivElement>('.session-history__viewport')!
    const bounds = (top: number, bottom: number) => ({
      top, bottom, left: 0, right: 500, width: 500, height: bottom - top, x: 0, y: top, toJSON() {}
    })
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => bounds(10, 210))
    const initialItem = host.querySelector<HTMLElement>('[data-history-item-id="initial-item"]')!
    let prependedHeight = 0
    vi.spyOn(initialItem, 'getBoundingClientRect').mockImplementation(() =>
      bounds(30 + prependedHeight - viewport.scrollTop, 70 + prependedHeight - viewport.scrollTop)
    )

    // Simulate user selecting text or clicking inside viewport
    viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

    // Load older page
    let resolveOlder!: (p: AgentSessionHistoryPage) => void
    historyPageSpy.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>((done) => { resolveOlder = done }))
    await act(async () => {
      viewport.scrollTop = 0
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    })

    // Older page prepends 100px above initial-item when React renders the new items
    let captured = false
    vi.mocked(initialItem.getBoundingClientRect).mockImplementation(() => {
      const growth = captured ? 100 : 0
      captured = true
      return bounds(30 + growth - viewport.scrollTop, 70 + growth - viewport.scrollTop)
    })
    await act(async () => resolveOlder(makePage('prepended-item', null)))

    const items = Array.from(host.querySelectorAll<HTMLElement>('[data-history-item-id]'), (r) => r.dataset.historyItemId)
    expect(items).toEqual(['prepended-item', 'initial-item'])
    // Viewport scrollTop must have adjusted to 100px so initialItem remains at exact same pixel offset (20px from viewport top)
    expect(viewport.scrollTop).toBe(100)
    expect(initialItem.getBoundingClientRect().top - viewport.getBoundingClientRect().top).toBe(20)
  })

  it('preserves existing loaded history and allows retry in the original direction on read failure', async () => {
    historyPageSpy.mockResolvedValueOnce(makePage('stable-first-page', 'cursor-1'))
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )
    expect(host.textContent).toContain('Message body for stable-first-page')

    // Older page read fails
    historyPageSpy.mockRejectedValueOnce(new Error('Network timeout loading older page'))
    const viewport = host.querySelector<HTMLDivElement>('.session-history__viewport')!
    await act(async () => {
      viewport.scrollTop = 0
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    })

    // Existing content must be kept
    expect(host.textContent).toContain('Message body for stable-first-page')
    expect(host.textContent).toContain('History read failed: Network timeout loading older page')

    // Retry repeats older direction
    historyPageSpy.mockResolvedValueOnce(makePage('older-page-on-retry', null))
    const retryBtn = [...host.querySelectorAll<HTMLButtonElement>('.session-history__notice button')].find(
      (btn) => btn.textContent?.includes('Retry')
    )
    expect(retryBtn).toBeDefined()
    await act(async () => retryBtn!.click())

    expect(historyPageSpy).toHaveBeenLastCalledWith(controlA, { cursor: 'cursor-1' })
    expect(host.textContent).toContain('Message body for older-page-on-retry')
    expect(host.textContent).toContain('Message body for stable-first-page')
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
          workspaceRoot="/test"
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
          workspaceRoot="/test"
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
          workspaceRoot="/test"
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
          workspaceRoot="/test"
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
          workspaceRoot="/test"
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
          workspaceRoot="/test"
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
          workspaceRoot="/test"
        />
      )
    )

    expect(host.querySelectorAll('.log-turn')).toHaveLength(3)
    // ScrollTop must stay at 20, not yanked to bottom
    expect(feed.scrollTop).toBe(20)
    expect(host.querySelector('.activity-feed__jump')).not.toBeNull()
  })

  it('preserves text selection and expanded disclosure state across non-interfering message updates', async () => {
    const partA: AgentSessionHistoryContentPart = {
      kind: 'tool-call',
      name: 'shell',
      input: 'echo "hello"',
      callId: 'call-1'
    }
    const partB: AgentSessionHistoryContentPart = {
      kind: 'text',
      text: 'Original paragraph with selectable text.'
    }

    historyPageSpy.mockResolvedValueOnce(makePage('msg-1', 'cursor-older-1', controlA.agentSessionId, [partA, partB]))
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    const trace = host.querySelector<TraceElement>(TRACE_SELECTOR)!
    expect(trace).not.toBeNull()
    await act(async () => {
      openTrace(trace)
    })
    expect(isTraceOpen(trace)).toBe(true)

    // Select text inside paragraph
    const p = host.querySelector('.log-turn__body p')!
    const textNode = p.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 8)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(sel.toString()).toBe('Original')

    // Append an older page
    const olderPart: AgentSessionHistoryContentPart = { kind: 'text', text: 'Older message' }
    historyPageSpy.mockResolvedValueOnce(makePage('msg-older', null, controlA.agentSessionId, [olderPart]))

    // Trigger load of older page
    const viewport = host.querySelector<HTMLDivElement>('.session-history__viewport')!
    viewport.scrollTop = 0
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))

    expect(historyPageSpy).toHaveBeenCalledTimes(2)
    const items = Array.from(host.querySelectorAll<HTMLElement>('[data-history-item-id]'), (r) => r.dataset.historyItemId)
    expect(items).toEqual(['msg-older', 'msg-1'])
    // Trace control must remain expanded
    expect(isTraceOpen(trace)).toBe(true)
    // Selected text node must still be connected to DOM
    expect(textNode.isConnected).toBe(true)
    expect(sel.toString()).toBe('Original')
  })

  it('renders duplicate part references and duplicate callId without React key collisions', async () => {
    const dupPart: AgentSessionHistoryContentPart = { kind: 'reasoning', text: 'duplicate reasoning' }
    const call1: AgentSessionHistoryContentPart = { kind: 'tool-call', name: 'sh', input: '1', callId: 'shared-id' }
    const call2: AgentSessionHistoryContentPart = { kind: 'tool-call', name: 'sh', input: '2', callId: 'shared-id' }

    const errors: unknown[][] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args)
    })

    historyPageSpy.mockResolvedValueOnce(
      makePage('msg-dup', null, controlA.agentSessionId, [dupPart, dupPart, call1, call2])
    )

    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    const keyWarnings = errors.filter(
      (args) => String(args[0]).includes('same key') || String(args[0]).includes('unique "key"')
    )
    expect(keyWarnings).toHaveLength(0)
    errorSpy.mockRestore()
  })

  it('does not re-parse Markdown during local copy or selection note keystrokes', async () => {
    const parser = vi.spyOn(markdown, 'parseAgentMarkdown')
    const content = '**body text** ' + 'prose '.repeat(50)

    await act(async () =>
      root.render(
        <ConversationMessage
          messageId="msg-memo-test"
          content={content}
          onAnnotate={vi.fn()}
        />
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

  it('same SessionPane owner preserves public native disclosure, selection, and pages through close/reopen for plain and opaque IDs', async () => {
    for (const id of ['plain-normal-record', 'native:normal-record']) {
      historyPageSpy.mockClear()
      await withPublicNativeHistory([id], async ({ pages, workspacePath, flush }) => {
        await mountNativeParent(workspacePath)
        await act(async () => await flush())
        expect(pages.map(page => page.items.map(item => item.id))).toEqual([[id]])
        const trace = host.querySelector<TraceElement>(TRACE_SELECTOR)!
        expect(trace).not.toBeNull()
        await act(async () => { openTrace(trace) })
        const text = host.querySelector('.log-turn__body p')!.firstChild!
        const range = document.createRange()
        range.setStart(text, 0); range.setEnd(text, 'Selectable'.length)
        window.getSelection()!.addRange(range)
        expect(window.getSelection()!.toString()).toBe('Selectable')
        const section = host.querySelector<HTMLElement>('.session-history')!
        const returnButton = section.querySelector<HTMLButtonElement>('.session-history__toolbar button')!
        expect(returnButton.textContent?.trim()).toBe('Terminal')
        await act(async () => returnButton.click())
        expect(section.hidden).toBe(true)
        expect(historyPageSpy).toHaveBeenCalledTimes(1)
        await openAgentHistory(host)
        expect(section.hidden).toBe(false)
        expect(host.querySelector(TRACE_SELECTOR)).toBe(trace)
        expect(isTraceOpen(trace)).toBe(true)
        expect(text.isConnected).toBe(true)
        expect(window.getSelection()!.toString()).toBe('Selectable')
        expect(historyPageSpy).toHaveBeenCalledTimes(1)
        expect(pages.map(page => page.items.map(item => item.id))).toEqual([[id]])
        window.getSelection()!.removeAllRanges()
      })
    }
  })

  it('same native record with unchanged reasoning survives an explicit Latest public page re-read', async () => {
    const parts: AgentSessionHistoryContentPart[] = [
      { kind: 'reasoning', text: 'private unchanged reasoning body' },
      { kind: 'tool-call', callId: 'stable-positive-tool', name: 'sh', input: 'private unchanged tool' }
    ]
    historyPageSpy.mockResolvedValueOnce(makePage('stable-record', null, controlA.agentSessionId, parts))
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    const traces = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
    expect(traces).toHaveLength(2)
    await act(async () => {
      openTrace(traces[0]!)
      openTrace(traces[1]!)
    })

    // Re-fetch on Latest with structuredClone (deserialized new objects)
    historyPageSpy.mockResolvedValueOnce(makePage('stable-record', null, controlA.agentSessionId, structuredClone(parts)))
    const latestBtn = [...host.querySelectorAll<HTMLButtonElement>('.session-history__toolbar button')].find(
      (btn) => btn.textContent?.includes('Latest')
    )!
    await act(async () => latestBtn.click())

    const updatedTraces = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
    expect(updatedTraces).toHaveLength(2)
    expect(isTraceOpen(updatedTraces[0]!)).toBe(true)
    expect(isTraceOpen(updatedTraces[1]!)).toBe(true)
  })

  it('hidden/reopen with pending older or latest releases loading and restores usable read control', async () => {
    for (const direction of ['older', 'latest'] as const) {
      historyPageSpy.mockResolvedValueOnce(makePage('kept-item', direction === 'older' ? 'c1' : null))
      await act(async () =>
        root.render(
          <SessionHistoryView
            control={controlA}
            label="Agent"
            visible={true}
            themeId="graphite"
            fontSize={12}
            workspaceRoot="/test"
            openWorkspaceFile={vi.fn()}
            openHttpLink={vi.fn()}
          />
        )
      )

      let resolvePending!: (page: AgentSessionHistoryPage) => void
      historyPageSpy.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>((done) => { resolvePending = done }))

      if (direction === 'older') {
        const loadEarlierBtn = host.querySelector<HTMLButtonElement>('.session-history__boundary button')!
        await act(async () => loadEarlierBtn.click())
      } else {
        const latestBtn = [...host.querySelectorAll<HTMLButtonElement>('.session-history__toolbar button')].find(
          (btn) => btn.textContent?.includes('Latest')
        )!
        await act(async () => latestBtn.click())
      }

      expect(host.textContent).toContain('Reading history…')

      // Hide view while request is pending
      await act(async () =>
        root.render(
          <SessionHistoryView
            control={controlA}
            label="Agent"
            visible={false}
            themeId="graphite"
            fontSize={12}
            workspaceRoot="/test"
            openWorkspaceFile={vi.fn()}
            openHttpLink={vi.fn()}
          />
        )
      )

      // Old request resolves while hidden
      await act(async () => resolvePending(makePage('stale-page', null)))

      // Re-show view
      await act(async () =>
        root.render(
          <SessionHistoryView
            control={controlA}
            label="Agent"
            visible={true}
            themeId="graphite"
            fontSize={12}
            workspaceRoot="/test"
            openWorkspaceFile={vi.fn()}
            openHttpLink={vi.fn()}
          />
        )
      )

      // Loading must be cleared, not stuck
      expect(host.textContent).not.toContain('Reading history…')
      const latestButton = [...host.querySelectorAll<HTMLButtonElement>('.session-history__toolbar button')].find(
        (btn) => btn.textContent?.includes('Latest')
      )!
      expect(latestButton.disabled).toBe(false)
      const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-history-item-id]'), (r) => r.dataset.historyItemId)
      expect(rows).toEqual(['kept-item'])

      await act(async () => root.unmount())
      root = createRoot(host)
    }
  })

  it('stable trace block identity: tool-call and tool-result sharing callId do not cross-expand, nor across rows or hosts', async () => {
    const call1: AgentSessionHistoryContentPart = {
      kind: 'tool-call',
      name: 'shell',
      input: 'command 1',
      callId: 'shared-call-id'
    }
    const result1: AgentSessionHistoryContentPart = {
      kind: 'tool-result',
      name: 'shell',
      output: 'output 1',
      callId: 'shared-call-id'
    }
    const msg1 = makePage('msg-with-shared-id', null, controlA.agentSessionId, [call1, result1])
    const call2: AgentSessionHistoryContentPart = {
      kind: 'tool-call',
      name: 'shell',
      input: 'command 2',
      callId: 'shared-call-id'
    }
    const msg2 = makePage('msg-2-shared-id', null, controlA.agentSessionId, [call2])
    const pageData: AgentSessionHistoryPage = {
      ...msg1,
      items: [...msg1.items, ...msg2.items]
    }
    historyPageSpy.mockResolvedValueOnce(pageData)

    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    const traces = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
    expect(traces).toHaveLength(3) // call1, result1 in msg1, and call2 in msg2
    // User expands only call1
    await act(async () => {
      openTrace(traces[0]!)
    })

    // Trigger re-render by changing label prop
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Updated Agent Name"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    const updatedTraces = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
    // call1 must be open, but result1 and call2 in msg2 must NOT be open!
    expect(isTraceOpen(updatedTraces[0]!)).toBe(true)
    expect(isTraceOpen(updatedTraces[1]!)).toBe(false)
    expect(isTraceOpen(updatedTraces[2]!)).toBe(false)

    // Also check different host: Host B must not inherit disclosure
    const controlRemote = { ...controlA, hostId: 'remote' }
    historyPageSpy.mockResolvedValueOnce({
      ...pageData,
      source: { providerId: 'codex', nativeSessionId: 'remote-sess' }
    })
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlRemote}
          label="Remote Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )
    const remoteTraces = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
    expect(isTraceOpen(remoteTraces[0]!)).toBe(false)
  })

  it('unambiguous tuple encoding: opaque message IDs with colons and overlapping prefix callIds do not collide', async () => {
    // Record 1: id 'native:record', tool callId 'x:tool-call:y'
    // Record 2: id 'native:record:tool-call:x', tool callId 'y'
    // With naive colon concatenation, both would produce 'native:record:tool-call:x:tool-call:y'
    const part0: AgentSessionHistoryContentPart = {
      kind: 'tool-call',
      name: 'sh',
      input: '{"command":"private 0"}',
      callId: 'x:tool-call:y'
    }
    const part1: AgentSessionHistoryContentPart = {
      kind: 'tool-call',
      name: 'sh',
      input: '{"command":"private 1"}',
      callId: 'y'
    }

    const collisionPage: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'private-native-main' },
      items: [
        {
          id: 'native:record',
          kind: 'assistant-message',
          contentParts: [part0, { kind: 'text', text: 'body 0' }]
        },
        {
          id: 'native:record:tool-call:x',
          kind: 'assistant-message',
          contentParts: [part1, { kind: 'text', text: 'body 1' }]
        }
      ],
      nextCursor: null
    }

    historyPageSpy.mockResolvedValueOnce(collisionPage)

    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    const details = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
    expect(details).toHaveLength(2)
    // The two traceIds must be distinct non-empty values
    expect(details[0]!.dataset.traceId).toBeTruthy()
    expect(details[1]!.dataset.traceId).toBeTruthy()
    expect(details[0]!.dataset.traceId).not.toBe(details[1]!.dataset.traceId)

    // Open first trace only
    await act(async () => {
      openTrace(details[0]!)
    })

    expect(isTraceOpen(details[0]!)).toBe(true)
    expect(isTraceOpen(details[1]!)).toBe(false)

    // Re-render view with same control
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Updated Agent Label"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    const detailsAfter = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
    expect(isTraceOpen(detailsAfter[0]!)).toBe(true)
    expect(isTraceOpen(detailsAfter[1]!)).toBe(false)
  })

  it('cross-row range covering older and newest page protects newest page from eviction and keeps selection intact', async () => {
    historyPageSpy.mockResolvedValueOnce(makePage('p0', 'c1'))
    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    // Load page 1
    historyPageSpy.mockResolvedValueOnce(makePage('p1', 'c2'))
    const viewport = host.querySelector<HTMLDivElement>('.session-history__viewport')!
    viewport.scrollTop = 0
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))

    // Load page 2
    historyPageSpy.mockResolvedValueOnce(makePage('p2', 'c3'))
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))

    const rowsBefore = Array.from(host.querySelectorAll<HTMLElement>('[data-history-item-id]'), (r) => r.dataset.historyItemId)
    expect(rowsBefore).toEqual(['p2', 'p1', 'p0'])

    // Now start loading page 4 (p3)
    let resolveFourth!: (page: AgentSessionHistoryPage) => void
    historyPageSpy.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>((done) => { resolveFourth = done }))
    await act(async () => {
      viewport.scrollTop = 0
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    })

    // User creates a selection starting in p1 and ending in p0!
    const p1 = host.querySelector<HTMLElement>('[data-history-item-id="p1"]')!
    const p0 = host.querySelector<HTMLElement>('[data-history-item-id="p0"]')!
    const p1Text = p1.querySelector('.log-turn__body p')?.firstChild!
    const p0Text = p0.querySelector('.log-turn__body p')?.firstChild!

    const range = document.createRange()
    range.setStart(p1Text, 2)
    range.setEnd(p0Text, 8)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    // Anchor is in p1, focus/end is in p0!

    // Fourth page resolves
    await act(async () => resolveFourth(makePage('p3', 'c4')))

    // p0 must remain connected, p0Text must remain connected, range endContainer must remain connected!
    expect(p0.isConnected).toBe(true)
    expect(p0Text.isConnected).toBe(true)
    expect(range.endContainer.isConnected).toBe(true)
    expect(host.querySelector('.session-history__notice')?.textContent ?? '').toContain('Scroll toward the beginning')
  })

  it('SessionPane mode roundtrip (terminal -> activity -> terminal) preserves history pages, selection, and does not re-read', async () => {
    const sessionObj: SessionSnapshot = {
      id: controlA.agentSessionId,
      hostId: 'local',
      workspacePath: '/test',
      label: 'Test Agent',
      createdAt: 1000,
      updatedAt: 1000,
      agentSessionUpdatedAt: 1000,
      processState: 'running',
      status: { state: 'running', source: 'run-process', observedAt: 1000 },
      latestOutputBytes: 0,
      kind: 'agent',
      providerId: 'codex',
      executorId: 'codex',
      control: controlA,
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' }
    }
    useAppStore.setState({
      sessions: [sessionObj],
      config: { appearance: { terminalTheme: 'graphite', terminalFontSize: 12 }, workspaces: [], executors: {} } as any,
      viewModes: { [controlA.agentSessionId]: 'terminal' }
    })

    // Mount page 1 on history open
    historyPageSpy.mockResolvedValueOnce(makePage('p-latest', 'c-1'))
    await act(async () =>
      root.render(
        <SessionPane
          sessionId={controlA.agentSessionId}
          surfaceKind="agent"
          interactiveResize={false}
          visible={true}
          linkOrigin={{ workspaceId: 'w', tabGroupId: 'g', tabId: 't', regionId: 'r' }}
        />
      )
    )

    // Open history
    await openAgentHistory(host)
    expect(historyPageSpy).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Message body for p-latest')

    // Load page 2 (older)
    historyPageSpy.mockResolvedValueOnce(makePage('p-older', null))
    const viewport = host.querySelector<HTMLDivElement>('.session-history__viewport')!
    viewport.scrollTop = 0
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))
    expect(historyPageSpy).toHaveBeenCalledTimes(2)
    const rowsBefore = Array.from(host.querySelectorAll<HTMLElement>('[data-history-item-id]'), (r) => r.dataset.historyItemId)
    expect(rowsBefore).toEqual(['p-older', 'p-latest'])

    // Select text in p-latest
    const pLatest = host.querySelector<HTMLElement>('[data-history-item-id="p-latest"]')!
    const textNode = pLatest.querySelector('.log-turn__body p')?.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 7)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(sel.toString()).toBe('Message')

    // Switch viewMode to 'activity'
    await act(async () => {
      useAppStore.setState({
        viewModes: { [controlA.agentSessionId]: 'activity' }
      })
    })

    // Verify activity is rendered and history is hidden / no extra history reads happened
    expect(historyPageSpy).toHaveBeenCalledTimes(2)

    // Switch viewMode back to 'terminal'
    await act(async () => {
      useAppStore.setState({
        viewModes: { [controlA.agentSessionId]: 'terminal' }
      })
    })

    // Open history again (or history is still open/preserved)
    if (!host.querySelector('.session-history__viewport')) {
      await openAgentHistory(host)
    }

    // Must still have 2 pages!
    const rowsAfter = Array.from(host.querySelectorAll<HTMLElement>('[data-history-item-id]'), (r) => r.dataset.historyItemId)
    expect(rowsAfter).toEqual(['p-older', 'p-latest'])
    // Text node must still be connected!
    expect(textNode.isConnected).toBe(true)
    expect(sel.toString()).toBe('Message')
    // ZERO new historyPage API calls made during mode switch (total remains 2, NOT 3)!
    expect(historyPageSpy).toHaveBeenCalledTimes(2)
  })

  it('two SessionPane Regions for same control own independent trace disclosure', async () => {
    const sessionObj: SessionSnapshot = {
      id: controlA.agentSessionId,
      hostId: 'local',
      workspacePath: '/test',
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
      config: { appearance: { terminalTheme: 'graphite', terminalFontSize: 12 }, workspaces: [], executors: {} } as any,
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

  it('three native tool parts with callIds x/x/x:0 retain distinct disclosure identity without key collisions', async () => {
    const callIds = ['x', 'x', 'x:0']
    const parts: AgentSessionHistoryContentPart[] = [
      ...callIds.map((id, index) => ({
        kind: 'tool-call' as const,
        name: 'sh',
        input: `{"command":"private inner ${index}"}`,
        callId: id
      })),
      { kind: 'text' as const, text: 'Selectable true native body' }
    ]

    const testPage: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'private-native-main' },
      items: [
        {
          id: 'native:inner-record',
          kind: 'assistant-message',
          contentParts: parts
        }
      ],
      nextCursor: null
    }

    historyPageSpy.mockResolvedValueOnce(testPage)

    const consoleErrors: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      consoleErrors.push(args.map(String).join(' '))
    })

    try {
      await act(async () =>
        root.render(
          <SessionHistoryView
            control={controlA}
            label="Agent"
            visible={true}
            themeId="graphite"
            fontSize={12}
            workspaceRoot="/test"
            openWorkspaceFile={vi.fn()}
            openHttpLink={vi.fn()}
          />
        )
      )

      const details = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
      expect(details).toHaveLength(3)
      expect(details[0]!.dataset.traceId).toBeTruthy()
      expect(details[1]!.dataset.traceId).toBeTruthy()
      expect(details[2]!.dataset.traceId).toBeTruthy()
      // All 3 trace IDs must be pairwise distinct!
      expect(details[0]!.dataset.traceId).not.toBe(details[1]!.dataset.traceId)
      expect(details[0]!.dataset.traceId).not.toBe(details[2]!.dataset.traceId)
      expect(details[1]!.dataset.traceId).not.toBe(details[2]!.dataset.traceId)

      // Open first trace only
      await act(async () => {
        openTrace(details[0]!)
      })

      expect(isTraceOpen(details[0]!)).toBe(true)
      expect(isTraceOpen(details[1]!)).toBe(false)
      expect(isTraceOpen(details[2]!)).toBe(false)

      const duplicateKeyWarnings = consoleErrors.filter(msg => msg.includes('same key') || msg.includes('unique "key"'))
      expect(duplicateKeyWarnings).toHaveLength(0)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('adding a later same-callId part preserves unchanged first-part disclosure and keeps new part closed on Latest', async () => {
    const part0: AgentSessionHistoryContentPart = {
      kind: 'tool-call',
      name: 'sh',
      input: '{"command":"initial"}',
      callId: 'x'
    }

    const initialPage: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'private-native-main' },
      items: [
        {
          id: 'native:append-record',
          kind: 'assistant-message',
          contentParts: [part0, { kind: 'text', text: 'body initial' }]
        }
      ],
      nextCursor: null
    }

    historyPageSpy.mockResolvedValueOnce(initialPage)

    await act(async () =>
      root.render(
        <SessionHistoryView
          control={controlA}
          label="Agent"
          visible={true}
          themeId="graphite"
          fontSize={12}
          workspaceRoot="/test"
          openWorkspaceFile={vi.fn()}
          openHttpLink={vi.fn()}
        />
      )
    )

    const details = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
    expect(details).toHaveLength(1)
    expect(isTraceOpen(details[0]!)).toBe(false)

    // Open first part
    await act(async () => {
      openTrace(details[0]!)
    })
    expect(isTraceOpen(details[0]!)).toBe(true)

    // Now page is updated by adding another tool-call with same callId 'x'
    const part1: AgentSessionHistoryContentPart = {
      kind: 'tool-call',
      name: 'sh',
      input: '{"command":"appended duplicate"}',
      callId: 'x'
    }
    const updatedPage: AgentSessionHistoryPage = {
      agentSessionId: controlA.agentSessionId,
      source: { providerId: 'claude', nativeSessionId: 'private-native-main' },
      items: [
        {
          id: 'native:append-record',
          kind: 'assistant-message',
          contentParts: [part0, part1, { kind: 'text', text: 'body initial' }]
        }
      ],
      nextCursor: null
    }

    historyPageSpy.mockResolvedValueOnce(updatedPage)
    const latestBtn = [...host.querySelectorAll<HTMLButtonElement>('.session-history__toolbar button')].find(
      (btn) => btn.textContent?.includes('Latest')
    )!
    await act(async () => latestBtn.click())

    const afterDetails = host.querySelectorAll<TraceElement>(TRACE_SELECTOR)
    expect(afterDetails).toHaveLength(2)
    // First part must remain open, and new second part must be closed!
    expect(isTraceOpen(afterDetails[0]!)).toBe(true)
    expect(isTraceOpen(afterDetails[1]!)).toBe(false)
  })
  it('public native Latest prunes only absent opaque records and preserves overlapping-prefix disclosure and selection in the same parent', async () => {
    const ids = ['native:record', 'native:record:tool-call:x']
    await withPublicNativeHistory(ids, async ({ pages, replaceRecords, workspacePath, flush }) => {
      await mountNativeParent(workspacePath)
      await act(async () => await flush())
      const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-history-item-id]'), row => row.dataset.historyItemId)
      expect(rows()).toEqual(ids)
      const details = Array.from(host.querySelectorAll<TraceElement>(TRACE_SELECTOR))
      expect(details).toHaveLength(2)
      await act(async () => { for (const el of details) { openTrace(el) } })
      expect(details.map(el => isTraceOpen(el))).toEqual([true, true])
      const retainedText = host.querySelectorAll('.log-turn__body p')[1]!.firstChild!
      const range = document.createRange(); range.setStart(retainedText, 0); range.setEnd(retainedText, 'Selectable'.length)
      window.getSelection()!.addRange(range)
      const latest = host.querySelectorAll<HTMLButtonElement>('.session-history__toolbar button')[1]!
      expect(latest.textContent).toContain('Latest')
      await replaceRecords([ids[1]!])
      await act(async () => { latest.click(); await flush() })
      expect(rows()).toEqual([ids[1]])
      const retained = host.querySelector<TraceElement>(TRACE_SELECTOR)!
      expect(isTraceOpen(retained)).toBe(true)
      expect(retainedText.isConnected).toBe(true)
      expect(window.getSelection()!.toString()).toBe('Selectable')
      await replaceRecords(ids)
      await act(async () => { latest.click(); await flush() })
      expect(rows()).toEqual(ids)
      const reread = Array.from(host.querySelectorAll<TraceElement>(TRACE_SELECTOR))
      expect(reread).toHaveLength(2)
      expect(reread.map(el => isTraceOpen(el))).toEqual([false, true])
      expect(retainedText.isConnected).toBe(true)
      expect(window.getSelection()!.toString()).toBe('Selectable')
      expect(historyPageSpy).toHaveBeenCalledTimes(3)
      expect(pages.map(page => page.items.map(item => item.id))).toEqual([ids, [ids[1]], ids])
    })
  })

})
