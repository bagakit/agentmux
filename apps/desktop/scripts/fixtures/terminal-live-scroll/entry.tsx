import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Terminal } from '@xterm/xterm'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import '../../../src/renderer/src/styles/index.css'

type FixtureWindow = Window & {
  terminals: Terminal[]
  fixtureErrors: string[]
  wheelObservations: Array<{ event: WheelEvent; targetHistory: boolean; targetTerminal: boolean; hitHistory: boolean }>
  ready: boolean
  scrollInfo(): unknown
  finishScroll(): void
}
const w = window as unknown as FixtureWindow
w.terminals = []
w.fixtureErrors = []
w.wheelObservations = []
document.addEventListener('wheel', (event) => {
  const target = event.target instanceof Element ? event.target : null
  const hit = document.elementFromPoint(event.clientX, event.clientY)
  w.wheelObservations.push({ event,
    targetHistory: Boolean(target?.closest('.session-history__viewport')),
    targetTerminal: Boolean(target?.closest('.xterm')), hitHistory: Boolean(hit?.closest('.session-history__viewport'))
  })
}, { capture: true, passive: true })
window.addEventListener('error', (event) => w.fixtureErrors.push(event.message))
window.addEventListener('unhandledrejection', (event) => w.fixtureErrors.push(String(event.reason)))
const { useAppStore } = await import('../../../src/renderer/src/store')
const { SessionPane } = await import('../../../src/renderer/src/components/SessionPane')
const sessionId = '01a09b41-9e29-4197-ab97-9b81afc29ac4'
const runId = '83cc279a-84e4-40d1-8479-d864682530a9'
const tabId = 'ac4376d7-ee2f-463c-ae49-384b875bf5bf'
const regionId = '5f3068aa-e07f-4fc5-a0cf-07cb70e68a31'
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: sessionId, kind: 'agent', providerId: 'codex', executorId: 'codex',
  hostId: 'local', workspacePath: '/private-synthetic', label: 'Private native records',
  createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
  status: { state: 'working', source: 'native-hook', observedAt: 1 },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: sessionId, run: { runId } }
}
const tab = createWorkbenchTab(tabId, { regionId, kind: 'agent', phase: 'attached', workspaceId: 'private', sessionId })
useAppStore.setState({
  sessions: [session], tabs: { [tabId]: tab }, layouts: { private: createWorkspaceLayout('private-group', [tabId]) },
  activeWorkspaceId: 'private', mainSurface: 'workbench', pendingAgentLaunches: {}, recoveryCandidates: [],
  timelines: {}, agentNames: {}, viewModes: {}, regionCaretFocus: null,
  config: { version: 9, appearance: { terminalTheme: 'graphite' }, executors: {}, workspaces: [], hosts: [],
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
})
const root = createRoot(document.getElementById('container')!)
root.render(<SessionPane sessionId={sessionId} surfaceKind="agent" interactiveResize={false} visible
  linkOrigin={{ workspaceId: 'private', tabGroupId: 'private-group', tabId, regionId }} />)
let retainedTerminal: Terminal | undefined
w.scrollInfo = () => {
  const terminal = w.terminals.at(-1)
  retainedTerminal ??= terminal
  const buffer = terminal?.buffer.active
  const point = (element: Element | null) => {
    const r = element?.getBoundingClientRect()
    return r && r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  }
  const viewport = document.querySelector<HTMLElement>('.session-history__viewport')
  return {
    terminalCount: w.terminals.length, sameTerminal: terminal !== undefined && terminal === retainedTerminal,
    runId, grid: terminal && { cols: terminal.cols, rows: terminal.rows },
    buffer: buffer && { type: buffer.type, baseY: buffer.baseY, viewportY: buffer.viewportY, length: buffer.length },
    firstLine: buffer?.getLine(0)?.translateToString(true), mouse: terminal?.modes.mouseTrackingMode,
    terminalPoint: point(document.querySelector('.xterm-screen')),
    history: viewport && { itemIds: Array.from(viewport.querySelectorAll<HTMLElement>('[data-history-item-id]')).map(item => item.dataset.historyItemId),
      source: document.querySelector('.session-history__source')?.textContent,
      scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight,
      point: point(viewport), returnPoint: point(document.querySelector('.session-history__toolbar button')) },
    errors: [...w.fixtureErrors], wheels: w.wheelObservations.map(({ event, ...target }) => ({ ...target,
      deltaY: event.deltaY, isTrusted: event.isTrusted, cancelable: event.cancelable,
      // scrollInfo is read in a new task, after native dispatch has completed.
      defaultPrevented: event.defaultPrevented
    })), focusInTerminal: Boolean(document.activeElement?.closest('.xterm'))
  }
}
w.finishScroll = () => root.unmount()
w.ready = true
