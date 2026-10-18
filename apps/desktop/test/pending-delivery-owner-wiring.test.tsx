// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import type { SessionSnapshot } from '../src/shared/contracts'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { registerTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

const geometry = vi.hoisted(() => ({ active: 0, reads: [] as string[], top: 470 }))
// SessionPane, its explicit refs, original Composer/queue/request and Store are real.
// Terminal rendering and physical pixels are declared adapters; live paint belongs to E2E.
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => <div data-reading /> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session, linkOrigin }: { session: SessionSnapshot; linkOrigin: { regionId: string } }) => {
  useEffect(() => registerTerminalViewObservation({ regionId: linkOrigin.regionId, sessionId: session.id, runId: session.control.run.runId },
    () => ({ runId: session.control.run.runId, sampledAt: 1, visible: true, readOnly: false, liveReady: true, acceptsInput: true,
      viewGrid: { cols: 80, rows: 24 }, buffer: { type: 'normal', baseY: 0, viewportY: 0, length: 24 }, mouseTrackingMode: 'none' }), {
      readOverlapTop: popup => { geometry.reads.push(session.control.run.runId); return popup.top < geometry.top + 100 && popup.bottom > geometry.top ? geometry.top : undefined },
      subscribe: () => { geometry.active++; return () => { geometry.active-- } }
    }), [session.id, session.control.run.runId, linkOrigin.regionId])
  return <div data-original-terminal />
} }))
vi.mock('@floating-ui/dom', async () => ({ ...await vi.importActual('@floating-ui/dom'),
  autoUpdate: (_reference: unknown, _floating: unknown, update: () => void) => { update(); return () => {} },
  offset: (value: number) => ({ name: 'offset', options: value }), shift: () => ({}), size: () => ({}),
  computePosition: async (reference: { getBoundingClientRect(): DOMRect }, _floating: unknown, options: { middleware: Array<{ name?: string; options?: number }> }) =>
    ({ x: 0, y: reference.getBoundingClientRect().top - 40 - options.middleware.find(value => value.name === 'offset')!.options! })
}))
const original = useAppStore.getState(), session = composerSession('original-agent')
let root: Root, host: HTMLDivElement, style: HTMLStyleElement, controls: Array<{ mock: { calls: unknown[][] } }>
const pending = () => [...document.querySelectorAll<HTMLElement>('.composer-pending')].find(node => !node.hidden)!
const top = () => parseFloat(pending().style.top)
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  geometry.active = 0; geometry.reads = []; geometry.top = 470
  style = document.createElement('style'); style.textContent = '.composer-pending__cards{padding:6px}'; document.head.append(style)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('composer')) return new DOMRect(100, 600, 700, 50)
    if (this.classList.contains('agent-interaction-source') || this.classList.contains('agent-interaction')) return new DOMRect(500, 500, 300, 70)
    return new DOMRect(100, 80, 700, 570)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(352)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this === document.documentElement ? 1000 : 352 })
  useAppStore.setState({ ...original, config: composerConfig, sessions: [session], viewModes: { [session.id]: 'terminal' },
    timelines: { [session.id]: { agentSessionId: session.id, items: [], revision: 1 } }, agentComposerDrafts: { [session.id]: 'Keep original draft' },
    agentSteerQueues: { [session.id]: [{ operationId: 'original-pending', runId: session.control.run.runId, text: 'Original queued body', status: 'queued' }] },
    pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], error: null }, true)
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: session.id, source: { providerId: 'codex', nativeSessionId: 'original-native' }, items: [], nextCursor: null })
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source: { providerId: 'codex', nativeSessionId: 'original-native' }, dispose() {} })
  vi.spyOn(api.sessions, 'timeline').mockResolvedValue({ agentSessionId: session.id, items: [], revision: 1 })
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  controls = (['submitPrompt', 'recover', 'respondInteraction', 'write', 'stop'] as const).map(name => vi.spyOn(api.sessions, name))
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); style.remove(); useAppStore.setState(original, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(primary = true, secondary = false) {
  const target: WorkbenchViewTarget = { hostId: 'secondary-layout', active: secondary, visible: secondary, surface: 'space',
    reference: { displayWorkspaceId: 'workspace', groupId: 'secondary-group', tabId: 'secondary-tab', regionId: 'original-region' } }
  await act(async () => root.render(<>
    <div id={workbenchSessionStageHostId(target, 'original-region')} hidden={!secondary} />
    <div hidden={!primary}><SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible={primary}
      linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'original-region' }}
      presentations={[target]} renderPresentationFrame={content => content} /></div>
  </>))
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
}
function preserved() {
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep original draft')
  expect(useAppStore.getState().agentSteerQueues[session.id]?.map(item => item.operationId)).toEqual(['original-pending'])
  for (const control of controls) expect(control).not.toHaveBeenCalled()
}
it('passes the exact primary terminal port through the original Composer and releases it while hidden', async () => {
  await render(); expect(geometry.active).toBe(1); expect(top() + 40).toBeLessThanOrEqual(geometry.top - 2)
  expect(new Set(geometry.reads)).toEqual(new Set([session.control.run.runId])); preserved()
  await render(false); expect(geometry.active).toBe(0)
  await render(); expect(geometry.active).toBe(1); preserved()
})
it('passes the current original interaction node independently of terminal geometry and retains its exact request', async () => {
  geometry.top = 100
  const request = { kind: 'permission' as const, id: 'original-request', agentSessionId: session.id, title: 'Original request', options: [],
    evidence: { source: 'native-hook' as const, observedAt: 1, run: session.control.run, hookReceiptId: 'original-request' } }
  useAppStore.setState({ sessions: [{ ...session, pendingInteraction: request }] })
  await render(); expect(host.querySelector('[data-request-id="original-request"]')).not.toBeNull()
  expect(top() + 40).toBeLessThanOrEqual(498); preserved()
})
it('gives an auxiliary reading presentation its own boundary without borrowing primary terminal observations', async () => {
  useAppStore.setState({ viewModes: { [session.id]: 'activity' } })
  await render(false, true)
  expect(host.querySelector('[data-session-presentation] .composer')).not.toBeNull()
  expect(pending()).toBeDefined(); expect(pending().dataset.positioned).toBe('true')
  expect(geometry.active).toBe(0); expect(geometry.reads).toEqual([]); preserved()
})
