import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Terminal } from '@xterm/xterm'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import '../../../src/renderer/src/styles/index.css'
import { terminalOptions } from '../../../src/renderer/src/lib/terminal-theme'

type FixtureWindow = Window & {
  terminals: Terminal[]
  fixtureErrors: string[]
  wheelObservations: Array<{ event: WheelEvent; targetHistory: boolean; targetTerminal: boolean; hitHistory: boolean; hitTerminal: boolean }>
  ready: boolean
  scrollInfo(): unknown
  finishScroll(): void
  showCold(): void
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
    targetTerminal: Boolean(target?.closest('.xterm')), hitHistory: Boolean(hit?.closest('.session-history__viewport')), hitTerminal: Boolean(hit?.closest('.xterm'))
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
const phase = new URL(window.location.href).searchParams.get('phase')
const disposeStore = await useAppStore.getState().initialize()
if (phase === 'capture') {
  const tab = createWorkbenchTab(tabId, { regionId, kind: 'agent', phase: 'attached', workspaceId: 'private', sessionId })
  useAppStore.setState({ tabs: { [tabId]: tab }, layouts: { private: createWorkspaceLayout('private-group', [tabId]) },
    activeWorkspaceId: 'private', mainSurface: 'workbench' })
  useAppStore.getState().focusRegion('private', tabId, regionId, 'keyboard')
}
const options = terminalOptions('graphite', 17)
const appearanceProbe = document.createElement('div')
appearanceProbe.style.cssText = 'position:absolute;visibility:hidden'
Object.assign(appearanceProbe.style, { backgroundColor: options.theme!.background, color: options.theme!.foreground,
  fontFamily: options.fontFamily, fontSize: `${options.fontSize}px`, lineHeight: String(options.lineHeight) })
document.body.append(appearanceProbe)
const appearanceStyle = getComputedStyle(appearanceProbe)
const expectedAppearance = { background: appearanceStyle.backgroundColor, foreground: appearanceStyle.color,
  fontFamily: appearanceStyle.fontFamily, fontSize: appearanceStyle.fontSize, lineHeight: appearanceStyle.lineHeight }
appearanceProbe.remove()
const root = createRoot(document.getElementById('container')!)
root.render(<SessionPane sessionId={sessionId} surfaceKind="agent" interactiveResize={false} visible
  linkOrigin={{ workspaceId: 'private', tabGroupId: 'private-group', tabId, regionId }} />)
w.showCold = () => {
  const done = { state: 'done' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() - 86401000 }
  useAppStore.setState({ sessions: [{ ...session, processState: 'exited', status: done, semanticStatus: done }] })
  useAppStore.getState().setAgentComposerDraft(sessionId, 'Private inline draft survives process restart')
}
let retainedTerminal: Terminal | undefined
w.scrollInfo = () => {
  const terminal = w.terminals.at(-1)
  retainedTerminal ??= terminal
  const buffer = document.querySelector('.xterm') ? terminal?.buffer.active : undefined
  const point = (element: Element | null) => {
    const r = element?.getBoundingClientRect()
    return r && r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  }
  const viewport = document.querySelector<HTMLElement>('.session-history__viewport')
  return {
    terminalCount: w.terminals.length, sameTerminal: terminal !== undefined && terminal === retainedTerminal,
    runId, projection: { tab: useAppStore.getState().tabs[tabId], layout: useAppStore.getState().layouts.private,
      activeWorkspaceId: useAppStore.getState().activeWorkspaceId, draft: useAppStore.getState().agentComposerDrafts[sessionId] },
    expectedAppearance, composerText: document.querySelector('[data-agent-composer]')?.textContent ?? document.querySelector('[contenteditable="true"]')?.textContent,
    grid: terminal && { cols: terminal.cols, rows: terminal.rows },
    buffer: buffer && { type: buffer.type, baseY: buffer.baseY, viewportY: buffer.viewportY, length: buffer.length },
    firstLine: buffer?.getLine(0)?.translateToString(true), mouse: terminal?.modes.mouseTrackingMode,
    terminalPoint: point(document.querySelector('.xterm-screen')),
    history: viewport && { itemIds: Array.from(viewport.querySelectorAll<HTMLElement>('[data-history-item-id]')).map(item => item.dataset.historyItemId),
      source: document.querySelector('.session-history__source')?.textContent,
      scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight,
      point: point(viewport), returnPoint: point(Array.from(viewport.closest('section')!.querySelectorAll('button')).find(button => ['Terminal', 'Session'].includes(button.textContent?.trim() ?? '')) ?? null),
      sectionClass: viewport.closest('section')?.className,
      buttonLabels: Array.from(viewport.closest('section')!.querySelectorAll('button'), button => button.textContent?.trim()),
      appearance: (() => { const s = getComputedStyle(viewport.closest('section')!); return {
        background: s.backgroundColor, foreground: s.color, fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight } })(),
      bodyAppearance: (() => { const body = viewport.querySelector('.log-turn__body'); if (!body?.textContent?.trim()) return null; const s = getComputedStyle(body); return {
        fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, foreground: s.color } })() },
    terminalAppearance: terminal && { fontFamily: terminal.options.fontFamily, fontSize: terminal.options.fontSize,
      lineHeight: terminal.options.lineHeight, theme: terminal.options.theme },
    errors: [...w.fixtureErrors], wheels: w.wheelObservations.map(({ event, ...target }) => ({ ...target,
      deltaY: event.deltaY, isTrusted: event.isTrusted, cancelable: event.cancelable,
      // scrollInfo is read in a new task, after native dispatch has completed.
      defaultPrevented: event.defaultPrevented
    })), focusInTerminal: Boolean(document.activeElement?.closest('.xterm'))
  }
}
w.finishScroll = () => { root.unmount(); disposeStore(); window.dispatchEvent(new Event('beforeunload')) }
w.ready = true
