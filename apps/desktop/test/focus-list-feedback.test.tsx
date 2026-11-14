import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxClientEvent } from '@agentmux/core'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { AgentOperationFeedback } from '../src/renderer/src/components/AgentOperationFeedback'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { beginAgentOperation, agentOperationKey } from '../src/renderer/src/lib/agent-operation-feedback'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import type { AgentOperationFeedback as Operation } from '../src/renderer/src/lib/agent-operation'
import feedbackStyles from 'virtual:focus-list-feedback-styles'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFeedbackMutations, listFeedbackSources } from '../scripts/verify-focus-list-feedback-mutations.mjs'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))

const initial = useAppStore.getState()
type EventListener = Parameters<typeof api.sessions.onEvent>[0]
const listeners = new Set<EventListener>()
const intersections = new Map<Element, (intersecting: boolean) => void>()
let host: HTMLDivElement, root: Root
const draws = { surface: 0, activity: 0, rows: new Map<string, number>() }
const selected = vi.fn()
const subject = { hostId: 'local', agentSessionId: 'sender' }
function event(sequence: number, sender = 'sender', recipient = 'receiver', recordKind: 'message' | 'dispatch-open' | 'dispatch-event' = 'message'): Extract<AgentMuxClientEvent, { type: 'agent-message-changed' }> {
  return { type: 'agent-message-changed', messageId: `original-message-${sequence}`, sequence, messageSequence: sequence, live: true,
    recordKind, senderSessionId: sender, recipientSessionId: recipient }
}
async function emit(value: AgentMuxClientEvent, hostId = 'local') {
  await act(async () => { for (const listener of [...listeners]) listener({ hostId, event: value }) })
}
function card(id: string, hostId = 'local') {
  const found = host.querySelector<HTMLElement>(`[data-focus-agent-host="${hostId}"][data-focus-agent-session="${id}"]`)
  expect(found, `Actual List card ${hostId}/${id}`).not.toBeNull()
  return found!
}
function feedback(id: string) { return card(id).querySelector<HTMLElement>('.focus-communication-feedback') }
async function render(visible = true) {
  await act(async () => root.render(<GlobalFocusSurface visible={visible} workspaceOpen={false} onSelectContext={selected} />))
}
function operation(id = 'original-stop', phase: Operation['phase'] = 'pending'): Operation {
  return { kind: 'stop', operationId: id, subject, control: composerSession('sender').control, phase, startedAt: Date.now() }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  draws.surface = 0; draws.activity = 0; draws.rows.clear(); listeners.clear(); intersections.clear(); selected.mockReset()
  vi.stubGlobal('__focusListRender', (kind: string, id?: string) => {
    if (kind === 'surface') draws.surface++
    else if (kind === 'activity') draws.activity++
    else if (id) draws.rows.set(id, (draws.rows.get(id) ?? 0) + 1)
  })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      const update = (isIntersecting: boolean) => this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      intersections.set(target, update); update(true)
    }
    disconnect() {}
  })
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: composerConfig.workspaces[0]!.path })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  const sessions = ['sender', 'receiver', 'neighbor', 'other'].map(id => {
    const original = composerSession(id)
    return { ...original, label: `Original ${id}`, semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  })
  useAppStore.setState({ ...initial, loading: false, config: composerConfig, sessions, mainSurface: 'agents', focusView: 'list',
    agentNames: {}, timelines: {}, tabs: {}, layouts: {}, activeWorkspaceId: composerConfig.workspaces[0]!.id,
    scratchTopicSnapshots: {}, agentOperations: {}, agentComposerDrafts: { sender: 'Original unsent input' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('routes original live observations through Global Focus and the real List card chain without business completion or extra reads', async () => {
  const reads = [vi.spyOn(api.sessions, 'messageEvents'), vi.spyOn(api.sessions, 'spawns')]
  const controls = [vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'write'), vi.spyOn(api.sessions, 'launchAgent')]
  await render(); card('sender'); card('receiver'); card('neighbor')
  const original = useAppStore.getState(), counts = reads.map(read => read.mock.calls.length)
  await emit(event(1))
  expect(feedback('sender')?.dataset.direction).toBe('sent'); expect(feedback('receiver')?.dataset.direction).toBe('received')
  expect(feedback('sender')?.textContent).toContain('观察到发送'); expect(feedback('receiver')?.textContent).toContain('观察到接收')
  expect(feedback('neighbor')).toBeNull(); expect(host.querySelector('[data-phase="succeeded"]')).toBeNull()
  expect(useAppStore.getState().agentOperations).toBe(original.agentOperations)
  expect(useAppStore.getState().sessions).toBe(original.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(reads.map(read => read.mock.calls.length)).toEqual(counts)
  expect(controls.every(control => control.mock.calls.length === 0)).toBe(true)
  expect(draws.activity).toBe(draws.surface); expect(draws.surface).toBeGreaterThan(0)
})

it.each(['dispatch-open', 'dispatch-event'] as const)('keeps %s supervision separate from a message send or successful operation', async kind => {
  await render(); await emit(event(1, 'sender', 'receiver', kind))
  for (const id of ['sender', 'receiver']) {
    expect(feedback(id)?.dataset.direction).toBe('updated'); expect(feedback(id)?.textContent).toBe('派发记录更新')
    expect(feedback(id)?.textContent).not.toContain('发送'); expect(card(id).querySelector('[data-phase="succeeded"]')).toBeNull()
  }
})

it('keeps exact Host scope, historical/duplicate events, and observation gaps in the original activity owner', async () => {
  await render()
  await emit(event(1), 'other-host'); expect(feedback('sender')).toBeNull()
  await emit({ ...event(1), live: false }); expect(feedback('sender')).toBeNull()
  await emit(event(2)); const mark = feedback('sender')!.querySelector('.focus-communication-feedback__mark')
  await emit(event(2)); expect(feedback('sender')!.querySelector('.focus-communication-feedback__mark')).toBe(mark)
  await emit({ type: 'agent-message-observation', state: 'unavailable' })
  expect(feedback('sender')).toBeNull(); expect(feedback('receiver')).toBeNull()
})

it('retains unrelated activity references and real card bodies when another pair receives an event', async () => {
  await render(); await emit(event(1))
  const counts = new Map(draws.rows), sender = feedback('sender')!, mark = sender.querySelector('.focus-communication-feedback__mark')
  await emit(event(2, 'neighbor', 'other'))
  expect(feedback('sender')).toBe(sender); expect(sender.querySelector('.focus-communication-feedback__mark')).toBe(mark)
  expect(draws.rows.get('sender')).toBe(counts.get('sender')); expect(draws.rows.get('receiver')).toBe(counts.get('receiver'))
  expect(feedback('neighbor')?.dataset.direction).toBe('sent'); expect(feedback('other')?.dataset.direction).toBe('received')
  expect(draws.activity).toBe(draws.surface)
})

it('keeps the original expiry and does not replay historical observations after List hiding and return', async () => {
  await render(); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  await emit(event(1)); expect(feedback('sender')).not.toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(3201) })
  expect(feedback('sender')).toBeNull()
  await emit(event(2)); await render(false); expect(feedback('sender')).toBeNull()
  await emit(event(3)); await render(true); expect(feedback('sender')).toBeNull()
  await emit(event(2)); expect(feedback('sender')).toBeNull()
  await emit(event(4)); expect(feedback('sender')?.dataset.direction).toBe('sent')
})

it('preserves the original animation phase after a related leaf leaves and reenters its viewport', async () => {
  await render(); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  await emit(event(1)); const node = feedback('sender')!, update = intersections.get(node)
  expect(update).toBeTypeOf('function')
  await act(async () => update!(false)); await act(async () => { await vi.advanceTimersByTimeAsync(600) }); await act(async () => update!(true))
  expect(node.dataset.motionActive).toBe('true'); expect(parseFloat(node.style.getPropertyValue('--activity-delay'))).toBeLessThanOrEqual(-600)
  const oldMark = node.querySelector('.focus-communication-feedback__mark')
  await emit(event(2)); expect(node.querySelector('.focus-communication-feedback__mark')).not.toBe(oldMark)
})

it('applies the actual reachable CSS to a visible and parked communication mark', async () => {
  const style = document.createElement('style'); style.textContent = feedbackStyles; document.head.append(style)
  try {
    await render(); await emit(event(1)); const node = feedback('sender')!, mark = node.querySelector<HTMLElement>('.focus-communication-feedback__mark')!
    expect(getComputedStyle(mark).animationPlayState).toBe('running')
    await act(async () => intersections.get(node)!(false))
    expect(getComputedStyle(mark).animationPlayState).toBe('paused')
    expect(host.querySelector('.agent-operation-feedback__motion')).toBeNull()
  } finally { style.remove() }
})

it('keeps pending glyph accents consistent through the real animated wrapper and parked SVG', async () => {
  const style = document.createElement('style'); style.textContent = feedbackStyles; document.head.append(style)
  const releaseTheme = mountThemeRuntime(window, { appAppearance: 'dark' })
  try {
    beginAgentOperation(operation())
    beginAgentOperation({ kind: 'fork', operationId: 'original-fork', subject, phase: 'pending', startedAt: Date.now() })
    await render()
    const owner = card('sender').querySelector<HTMLElement>('.agent-operation-feedback')!
    const entries = [...owner.querySelectorAll<HTMLElement>('.agent-operation-feedback__item')]
    expect(entries).toHaveLength(2)
    expect(entries.every(entry => entry.querySelector('summary > .semantic-icon-motion > svg'))).toBe(true)
    const colors = () => entries.map(entry => getComputedStyle(entry.querySelector<SVGElement>('summary svg')!).color)
    const visible = colors()
    expect(visible.every(color => color.trim().length > 0)).toBe(true)
    await act(async () => intersections.get(owner)!(false))
    expect(entries.every(entry => entry.querySelector('summary > svg'))).toBe(true)
    const parked = colors()
    console.log('LIST_PENDING_COLORS ' + JSON.stringify({ visible, parked }))
    expect(visible).toEqual(parked)
    expect(visible[0]).not.toBe(visible[1])
  } finally { releaseTheme(); style.remove() }
})

it('rejects old or source-mismatched explicit receipts without running a new mutation proof', async () => {
  const workspace = process.cwd()
  const runner = 'apps/desktop/scripts/verify-focus-list-feedback-mutations.mjs'
  const inputs = [...listFeedbackSources, 'apps/desktop/test/vitest.focus-list-feedback.config.mts', 'apps/desktop/test/focus-list-feedback.test.tsx', runner]
  const source = Object.fromEntries(await Promise.all(inputs.map(async file => [file, createHash('sha256').update(await readFile(join(workspace, file))).digest('hex')])))
  const directory = await mkdtemp(join(tmpdir(), 'amux-list-reuse-rejections-'))
  try {
    const cases = [
      { label: 'old-eleven', mutations: listFeedbackMutations.slice(0, 11), inputs: source, error: /Saved mutation definitions must match every current case/ },
      { label: 'changed-source', mutations: listFeedbackMutations, inputs: { ...source, [runner]: '0'.repeat(64) }, error: /Saved mutation inputs must match current bytes/ }
    ]
    for (const item of cases) {
      const path = join(directory, item.label + '.json')
      const bytes = JSON.stringify({ schema: 'agentmux.focus-list-source-mutations.v1', passed: true,
        cases: item.mutations, sourceBefore: item.inputs, sourceAfter: item.inputs })
      await writeFile(path, bytes)
      const result = spawnSync(process.execPath, [runner], { cwd: workspace, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, AGENTMUX_LIST_FEEDBACK_RECEIPT: path, AGENTMUX_LIST_FEEDBACK_EVIDENCE: path } })
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/AssertionError/); expect(result.stderr).toMatch(item.error)
      expect(result.stdout).not.toContain('LIST_MUTATION'); expect(await readFile(path, 'utf8')).toBe(bytes)
    }
    expect((await readdir(directory)).sort()).toEqual(['changed-source.json', 'old-eleven.json'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.each(['pending', 'unconfirmed', 'partial', 'failed', 'retired'] as const)('keeps original %s operation reading and restores focus from inside its closing detail', async phase => {
  const original = operation('original-stop', phase); beginAgentOperation(original)
  await render(); const entry = card('sender').querySelector<HTMLDetailsElement>('details.agent-operation-feedback__item')!
  expect(entry).not.toBeNull(); const trigger = entry.querySelector<HTMLElement>('summary')!
  await act(async () => trigger.click())
  expect(entry.open).toBe(true); const detail = entry.querySelector<HTMLElement>('.agent-operation-feedback__detail')!
  expect(detail.hasAttribute('inert')).toBe(false); expect(detail.textContent).toContain(original.operationId)
  const close = [...detail.querySelectorAll('button')].find(control => control.textContent === '收起')!
  expect(close).toBeDefined(); close.focus(); expect(document.activeElement).toBe(close)
  await act(async () => close.click())
  expect(entry.open).toBe(false); expect(detail.hasAttribute('inert')).toBe(true); expect(detail.getAttribute('aria-hidden')).toBe('true')
  expect(document.activeElement).toBe(trigger)
  expect(useAppStore.getState().agentOperations[agentOperationKey(original)]).toBe(original)
  expect(entry.querySelector('[data-icon-animation="spin"]') !== null).toBe(phase === 'pending')
})

it('keeps a pending operation and its opened detail when the original workface becomes inactive', async () => {
  const original = operation(); beginAgentOperation(original)
  const draw = (active: boolean) => act(async () => root.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}><AgentOperationFeedback subject={subject} /></WorkbenchPresentationContext.Provider>))
  await draw(true); const trigger = host.querySelector<HTMLElement>('summary')!; await act(async () => trigger.click())
  const detail = host.querySelector('.agent-operation-feedback__detail')!
  await draw(false); expect(host.querySelector('.agent-operation-feedback__detail')).toBe(detail)
  expect(host.querySelector('[data-motion-active="true"]')).toBeNull(); expect(host.textContent).toContain(original.operationId)
  expect(useAppStore.getState().agentOperations[agentOperationKey(original)]).toBe(original)
})
