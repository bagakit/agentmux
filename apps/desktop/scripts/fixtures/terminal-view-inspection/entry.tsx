import React from 'react'
import { createRoot } from 'react-dom/client'
import type { SessionSnapshot } from '../../../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

// Observe only the public constructor. No parser, buffer, input or mode override.
const w = window as any
w.terminals = []
w.fixtureErrors = []
window.addEventListener('error', (event) => w.fixtureErrors.push(event.message))
window.addEventListener('unhandledrejection', (event) => w.fixtureErrors.push(String(event.reason)))
const { useAppStore } = await import('../../../src/renderer/src/store')
const { api } = await import('../../../src/renderer/src/lib/api')
const { SessionPane } = await import('../../../src/renderer/src/components/SessionPane')
const regionId = '5f3068aa-e07f-4fc5-a0cf-07cb70e68a31'
const tabId = 'ac4376d7-ee2f-463c-ae49-384b875bf5bf'
const sessionId = '01a09b41-9e29-4197-ab97-9b81afc29ac4'
const runId = '83cc279a-84e4-40d1-8479-d864682530a9'
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: sessionId, kind: 'agent', providerId: 'codex', executorId: 'codex',
  hostId: 'local', workspacePath: '/private-synthetic', label: 'Private inspection',
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
// Actual Desktop control adapter and preload transport; synthetic runtime facts stay in Main.
const disposeControl = api.control.onRequest((request, signal) => useAppStore.getState().executeControl(request, signal))
const root = createRoot(document.getElementById('container')!)
let generation = 0
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
w.mountInspection = async (input: { alternate: boolean; mouse: boolean; readOnly: boolean; pending: boolean }) => {
  await w.inspectionFixture.setup(input)
  w.terminals = []
  useAppStore.setState({ sessions: [{ ...session, ...(input.pending ? { pendingInteraction: {
    id: 'private-permission', kind: 'permission' as const, agentSessionId: sessionId,
    title: 'Private permission', options: [], evidence: { source: 'native-hook' as const, observedAt: 1, run: session.control.run }
  } } : {}) }] })
  root.render(<SessionPane key={++generation} sessionId={sessionId} surfaceKind="agent" interactiveResize={false} visible readOnly={input.readOnly}
    linkOrigin={{ workspaceId: 'private', tabGroupId: 'private-group', tabId, regionId }} />)
  for (let attempt = 0; attempt < 100; attempt++) {
    await wait(25)
    const terminal = w.terminals.at(-1)
    if (!terminal || (input.alternate ? terminal.buffer.active.type !== 'alternate' : terminal.buffer.active.length < 500)) continue
    await wait(100)
    if (!input.alternate) terminal.scrollToLine(300)
    await wait(50)
    return w.inspectionInfo()
  }
  throw new Error('Actual TerminalView did not mount its nonempty synthetic buffer')
}
w.inspectionInfo = () => {
  const terminal = w.terminals.at(-1)
  const buffer = terminal?.buffer.active
  return { count: w.terminals.length, runId, regionId, cols: terminal?.cols, rows: terminal?.rows,
    buffer: buffer && { type: buffer.type, baseY: buffer.baseY, viewportY: buffer.viewportY, length: buffer.length },
    mouseTrackingMode: terminal?.modes.mouseTrackingMode, errors: [...w.fixtureErrors] }
}
w.unmountInspection = async () => { root.render(null); await wait(100) }
w.finishInspection = () => { root.unmount(); disposeControl() }
w.ready = true
