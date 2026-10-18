// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { createAgentInputContextCaptureRecord } from '@agentmux/core/agent-input-context-capture'
import type { AgentMuxBrowserControl } from '@agentmux/core'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import type { BrowserOperation } from '../src/shared/browser-operation'
import type { BrowserInputScene } from '../src/shared/browser-input-context-capture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

// Real Pane, Message button, Composer, immutable capture and Store queue admission.
// Only native API ports are test seams; no Main/Provider delivery or native paint claim.
const dom = composerDOM()
const agentA = () => ({ ...composerSession('agent-a'), label: 'Earlier Agent',
  status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } })
const agentB = () => ({ ...composerSession('agent-b'), label: 'Associated Agent',
  status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } })
type Association = AgentMuxBrowserControl['agent']
let page: Awaited<ReturnType<typeof api.browser.create>>
let scene: BrowserInputScene
let earlier: BrowserOperation

beforeEach(async () => {
  page = await api.browser.create('associated-message-browser', 'https://example.invalid/associated', 'workspace')
  scene = { reference: { hostId: 'local', captureId: 'original-associated-scene' }, diskDurability: 'confirmed',
    inputContext: { kind: 'browser', version: 1, capturedAt: 1,
      browser: { hostId: 'local', browserId: page.id, navigationId: page.navigationId },
      page: { url: page.url, title: 'Original Browser page' } } }
  earlier = { id: 'earlier-operation', browserId: page.id, operator: { id: 'agent-a', name: 'Earlier Agent' },
    phase: 'completed', summary: 'Earlier operation', startedAt: 1, finishedAt: 2, url: page.url, steps: [] }
  useAppStore.setState({ toolsOpen: false, sessions: [agentA(), agentB()], browserOpinionDrafts: {}, agentSteerQueues: {},
    agentSteerInFlight: {}, agentSteerInFlightPhase: {} })
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'captureInputContext').mockResolvedValue(structuredClone(scene))
  vi.spyOn(api.browser, 'freezeInputContext').mockImplementation(async input => {
    const record = createAgentInputContextCaptureRecord({ reference: { hostId: 'local', operationId: input.operationId },
      binding: { executionHostId: input.control.hostId, agentSessionId: input.control.agentSessionId, originRun: input.control.run },
      prompt: input.prompt, ...(input.agentMuxNote === undefined ? {} : { agentMuxNote: input.agentMuxNote }), inputContext: scene.inputContext })
    return { reference: record.reference, record, diskDurability: 'confirmed' }
  })
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => {
    const current = useAppStore.getState().sessions.find(item => control.kind === 'agent' && item.kind === 'agent' && item.hostId === control.hostId && item.control.agentSessionId === control.agentSessionId)
    if (!current) throw new Error('Missing exact fixture Session')
    return current
  })
})

async function render(agent: Association, operation: BrowserOperation | null = null) {
  const control: AgentMuxBrowserControl = { owner: 'agent', ...(agent === undefined ? {} : { agent }), activeOperationId: null, revision: 7, inputIsolation: 'isolated' }
  await dom.render(<BrowserPane tab={{ ...page, kind: 'browser', browserId: page.id, regionId: 'associated-message-region', workspaceId: 'workspace',
    control, activity: { control: 'agent', operation } }} visible />)
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  expect(button, label).toBeDefined(); await act(async () => button!.click())
}
const editor = () => document.querySelector<HTMLTextAreaElement>('[aria-label="Opinion for Browser operator"]')!
async function queue() {
  const send = document.querySelector<HTMLButtonElement>('.browser-contextual-composer footer .primary-button')
  expect(send).not.toBeNull(); await act(async () => send!.click())
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor(), text)
    editor().dispatchEvent(new Event('input', { bubbles: true }))
    editor().dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const association = (session: ReturnType<typeof agentA>): Association => ({ hostId: session.control.hostId, agentSessionId: session.control.agentSessionId })
function expectOnlyQueue(session: ReturnType<typeof agentA>, text: string) {
  const queues = useAppStore.getState().agentSteerQueues
  expect(Object.keys(queues)).toEqual([session.control.agentSessionId])
  const entries = queues[session.control.agentSessionId]!
  expect(entries).toHaveLength(1)
  const entry = entries[0]!
  expect(entry.text).toBe(text); expect(entry.origin).toBe('manual'); expect(entry.sourceChannel).toBe('message-tool')
  expect(entry.browserRecipient).toEqual(session.control)
  expect(entry.browserInput?.control).toEqual(session.control)
  expect(entry.browserInput?.capture.record.binding).toEqual({ executionHostId: session.control.hostId,
    agentSessionId: session.control.agentSessionId, originRun: session.control.run })
  expect(entry.browserInput?.capture.record.inputContext).toEqual(scene.inputContext)
  expect(api.browser.freezeInputContext).toHaveBeenCalledExactlyOnceWith({ scene: scene.reference, control: session.control, operationId: entry.operationId, prompt: text })
}

it.each(['absent', 'earlier-agent'] as const)('queues a fresh Pane Message to current associated B when operation is %s', async history => {
  await render(association(agentB()), history === 'absent' ? null : earlier)
  await click('Message Browser operator'); await type('Message the associated Agent'); await queue()
  expectOnlyQueue(agentB(), 'Message the associated Agent')
  expect(api.browser.captureInputContext).toHaveBeenCalledExactlyOnceWith(page.id)
})

it('selects the exact remote Host among two presentations of the same canonical SID', async () => {
  const local = agentB(); local.id = 'local-presentation-of-b'
  const remote = agentB(); remote.hostId = 'remote-host'; remote.control.hostId = 'remote-host'
  useAppStore.setState({ sessions: [local, remote, agentA()] })
  await render(association(remote), earlier)
  await click('Message Browser operator'); await type('Remote original recipient'); await queue()
  expectOnlyQueue(remote, 'Remote original recipient')
})

it.each(['unknown', 'none'] as const)('keeps the Pane usable but does not borrow historical A as recipient when association is %s', async state => {
  await render(state === 'none' ? null : undefined, earlier)
  await click('Message Browser operator'); await type('Retained without a guessed recipient')
  expect(editor().value).toBe('Retained without a guessed recipient')
  const notice = document.querySelector('[role="alert"]')
  expect(notice).not.toBeNull(); expect(notice!.textContent!.trim().length).toBeGreaterThan(0)
  const send = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Queue text only')!
  expect(send).toBeDefined(); expect(send.disabled).toBe(true)
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
  expect(api.browser.captureInputContext).not.toHaveBeenCalled(); expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
  expect(dom.container.querySelector('.browser-toolbar')).not.toBeNull()
})

it('does not send through an inconsistent Session snapshot Host even when canonical control matches', async () => {
  const inconsistent = agentB(); inconsistent.control.hostId = 'remote-host'
  useAppStore.setState({ sessions: [agentA(), inconsistent] })
  await render({ hostId: 'remote-host', agentSessionId: 'agent-b' }, earlier)
  await click('Message Browser operator'); await type('Keep the original words')
  const notice = document.querySelector('[role="alert"]')
  expect(notice).not.toBeNull(); expect(notice!.textContent!.trim().length).toBeGreaterThan(0)
  expect(editor().value).toBe('Keep the original words')
  expect(useAppStore.getState().agentSteerQueues).toEqual({}); expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
})

it('keeps an existing A draft on its original Run when only the Pane association becomes B', async () => {
  await render(association(agentA()), earlier)
  await click('Message Browser operator'); await type('Existing A opinion')
  await render(association(agentB()), earlier)
  await queue()
  expectOnlyQueue(agentA(), 'Existing A opinion')
  expect(api.browser.captureInputContext).toHaveBeenCalledTimes(1)
})

it('restores an original A draft without retargeting it to current B or reading another page', async () => {
  useAppStore.setState({ browserOpinionDrafts: { [page.id]: { original: { control: agentA().control, name: 'Earlier Agent', browserId: page.id,
    operationId: earlier.id, scene: structuredClone(scene) }, text: 'Restored original A opinion', includeContext: true, pending: null } } })
  await render(association(agentB()))
  await click('Message Browser operator')
  expect(editor().value).toBe('Restored original A opinion')
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
  expect(api.browser.captureInputContext).not.toHaveBeenCalled(); expect(api.browser.freezeInputContext).not.toHaveBeenCalled()
  await queue()
  expectOnlyQueue(agentA(), 'Restored original A opinion')
  expect(api.browser.captureInputContext).not.toHaveBeenCalled()
})
