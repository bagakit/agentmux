import { flushSync } from 'react-dom'
import '../agent-region-actions/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { formatRegionAddress } from '../../../src/renderer/src/lib/agent-address'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import type { ContinuousProgressLoop } from '@agentmux/core'

const workspaceId = useAppStore.getState().activeWorkspaceId!
const tabId = 'region-actions-tab', leftId = 'region-actions-target', rightId = 'region-actions-survivor'
const names = ['Layout coordinator · investigate recovery without losing this original Agent', 'Notes researcher', 'Build reviewer']
const original = (window as any).regionActions
const first = useAppStore.getState().sessions[0]!
// Controlled API facts for the real UI: no timer, delivery or second loop manager.
let progressLoops: ContinuousProgressLoop[] = []
const progressListeners = new Set<(loop: ContinuousProgressLoop) => void>()
const progressReads: unknown[] = []
api.continuousProgress.list = async target => {
  progressReads.push(target)
  return progressLoops.filter(loop => loop.hostId === target.hostId && loop.agentSessionId === target.agentSessionId &&
    loop.providerId === target.providerId && loop.workspacePath === target.workspacePath)
}
api.continuousProgress.onChanged = listener => {
  progressListeners.add(listener)
  return () => { progressListeners.delete(listener) }
}
const third = (await api.sessions.launchAgent({ executorId: first.executorId!, hostId: 'local', workspacePath: first.workspacePath })).session
const clipboard: string[] = [], resizes: unknown[] = [], selections: unknown[] = []
const copy = api.ui.writeClipboardText, resize = api.sessions.resize
api.ui.writeClipboardText = async text => { clipboard.push(text); await copy(text) }
api.sessions.resize = async (...args) => { resizes.push(args); return resize(...args) }
for(const type of ['pointerdown','click','keydown'])document.addEventListener(type, event => {
  const item = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null
  const menu = item?.closest<HTMLElement>('.agent-region-menu')
  if (menu && (type !== 'keydown' || (event as KeyboardEvent).key === 'Enter')) selections.push({ type, pointerType: event instanceof PointerEvent ? event.pointerType : null, label: item!.textContent?.trim(), trusted: event.isTrusted,
    owner: menu.dataset.ownerRegionId, open: menu.dataset.state === 'open',
    active: useAppStore.getState().tabs[tabId]?.layout.activeRegionId })
}, true)
function naming() {
  const sessions = useAppStore.getState().sessions
  flushSync(() => useAppStore.setState({sessions: sessions.map((session, index) => index > 0 ? {
    ...session, providerId: sessions[0]!.providerId, executorId: sessions[0]!.executorId, label: sessions[0]!.label
  } : session), agentNames: Object.fromEntries(sessions.map((session, index) => [session.id, names[index]]))}))
}
const probe = {
  names,
  progress(state: 'inactive' | 'active' | 'paused' | 'unconfirmed') {
    const loop: ContinuousProgressLoop = { loopId: 'visual-progress', hostId: first.hostId, agentSessionId: first.id,
      providerId: first.providerId, workspacePath: first.workspacePath, intervalMs: 1_800_000,
      prompt: 'Continue the current task without replacing user input.', nextCheckAt: Date.parse('2026-10-03T12:00:00Z'),
      status: state === 'inactive' ? 'stopped' : state === 'active' ? 'active' : 'paused',
      ...(state === 'unconfirmed' ? { lastOutcome: 'unknown' as const,
        lastDecision: 'Previous continuation delivery is unconfirmed. No retry has been sent.' }
        : state === 'paused' ? { lastDecision: 'Paused while the user is editing.' } : {}) }
    progressLoops = state === 'inactive' ? [] : [loop]
    flushSync(() => { for (const listener of progressListeners) listener(loop) })
  },
  progressFacts() { return { reads: [...progressReads], subscribers: progressListeners.size } },
  terminalLoading() {
    const attach = api.sessions.attach
    let release!: () => void
    const waiting = new Promise<void>(done => { release = done })
    const timeout = setTimeout(release, 10_000)
    api.sessions.attach = async (...args) => { await waiting; return attach(...args) }
    const generation = original.mode('terminal'); naming()
    const state = useAppStore.getState()
    flushSync(() => useAppStore.setState({ sessions: state.sessions.map(session => session.kind === 'agent' ? {
      ...session, terminalCapability: { state: 'unknown', mode: 'degraded', reason: 'handshake-timeout',
        run: session.control.run, observedAt: Date.now() }
    } : session) }))
    return { generation, release() { clearTimeout(timeout); api.sessions.attach = attach; release() } }
  },
  mode(mode: 'terminal' | 'cold' | 'notice') { const generation = original.mode(mode); naming(); return generation },
  observe() { const generation = original.observe(); naming(); return generation },
  swap() {
    const generation = original.mode('terminal', third); naming()
    const state = useAppStore.getState(), sessions = state.sessions
    flushSync(() => useAppStore.setState({
      tabs: { ...state.tabs, 'unrelated-swap-tab': createWorkbenchTab('unrelated-swap-tab', {
        regionId: 'unrelated-swap-region', kind: 'launcher', workspaceId
      }) },
      agentComposerDrafts: Object.fromEntries(sessions.map(session => [session.id, `Unsent original ${session.id}`])),
      agentSteerQueues: Object.fromEntries(sessions.map(session => [session.id, [{ operationId: `pending-${session.id}`,
        runId: session.control.run.runId, text: `Unsent pending ${session.id}`, status: 'queued', enqueuedAt: 1 }]]))
    }))
    return generation
  },
  rename(index: number, name: string | null) { flushSync(() => useAppStore.getState().renameAgent(useAppStore.getState().sessions[index]!.id, name)) },
  focusNeighbor() { flushSync(() => useAppStore.getState().focusRegion(workspaceId, tabId, rightId, 'pointer')) },
  facts() {
    const state = useAppStore.getState()
    return { ...original.facts(), active: state.tabs[tabId]?.layout.activeRegionId, tabs: state.tabs,
      drafts: state.agentComposerDrafts, queues: state.agentSteerQueues, names: state.agentNames,
      regionAddress: formatRegionAddress(leftId), clipboard: [...clipboard], resizes: [...resizes], selections: [...selections] }
  },
  terminal() {
    const element = document.querySelector(`[data-workbench-region-id="${leftId}"] .xterm`) ?? document.querySelector('.xterm')
    const terminals = (window as any).identityTerminals as Array<{ id: number; terminal: { element: Element | undefined; cols: number; rows: number }; disposed: boolean }>
    const record = terminals.find(record => record.terminal.element === element)
    if (!record || record.disposed) throw new Error('The actual original xterm instance is absent')
    const r = element!.parentElement!.getBoundingClientRect()
    return { id: record.id, cols: record.terminal.cols, rows: record.terminal.rows,
      container: { x: r.x, y: r.y, width: r.width, height: r.height }, resizes: resizes.length }
  }
}
Object.assign(window, { identityMenu: probe })
probe.mode('terminal')
