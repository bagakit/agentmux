// @vitest-environment happy-dom
import { act } from 'react'
import * as floating from '@floating-ui/dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { AgentLifecycleFeedback } from '../src/renderer/src/components/AgentLifecycleFeedback'
import { ServiceNoticeDisclosure } from '../src/renderer/src/components/ServiceNoticeDisclosure'
import { ServiceWindowNotice } from '../src/renderer/src/components/ServiceWindowNotice'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { serviceNoticeFingerprint } from '../src/renderer/src/lib/use-service-notices'
import { api } from '../src/renderer/src/lib/api'
import { projectNotifications, useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { notificationTrigger, toggleNotificationCenter, toggleNotificationDetails } from './helpers/notification-center'

vi.mock('@floating-ui/dom', async importOriginal => {
  const actual = await importOriginal<typeof import('@floating-ui/dom')>()
  return { ...actual, computePosition: vi.fn(actual.computePosition) }
})

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ loading: false, sessions: [], tabs: {}, notificationEvents: [], noticeReadReceipts: {},
  error: null, lastError: null, errorNoticeContext: null, environmentWarning: undefined, runtimeOwnershipWarnings: [],
  runtimeEndpointWarnings: [], displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {},
  sessionNameMetadataWarning: null, workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null,
  desktopNavigationNotice: null, startupAgentAvailability: undefined } as never))

function agent(id: string, problems = 1) {
  const base = composerSession(id)
  return { ...base, label: `Session ${id}`, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() },
    nativeSourceObservation: { state: 'unknown' as const, run: base.control.run, observedAt: 1, reason: 'current-main-unconfirmed' },
    ...(problems > 1 ? { creation: { createOperationId: `create-${id}`, initialPrompt: 'unknown' as const,
      agentMuxContext: 'confirmed' as const, intentDigest: `intent-${id}` } } : {}),
    ...(problems > 2 ? { timelineObservation: { run: base.control.run, code: 'HISTORY_UNAVAILABLE', message: 'The original history could not be read.' } } : {}) }
}
const rows = () => [...dom.container.querySelectorAll<HTMLElement>('.notification-item')]
const groups = () => [...dom.container.querySelectorAll<HTMLElement>('.notification-group[data-group-id]')]
const unread = () => Number(notificationTrigger(dom.container).getAttribute('aria-label')?.match(/(\d+) unread/u)?.[1])
async function click(selector: string) { await dom.click(selector) }
async function section(value: 'current' | 'history') { await click(`[role="tab"][data-section="${value}"]`) }
async function category(value: string) { await click(`button[data-category="${value}"]`) }
async function markShown() {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Mark shown read')
  expect(button, 'A named action defines the current view and category read scope').toBeTruthy()
  await act(async () => button!.click())
}
async function expandGroups() {
  for (const button of [...dom.container.querySelectorAll<HTMLButtonElement>('.notification-group__more')])
    if (button.getAttribute('aria-expanded') !== 'true') await act(async () => button.click())
}
function LocalService({ id }: { id: string }) {
  const session = useAppStore(state => state.sessions.find(item => item.id === id))
  const notices = sessionServiceNotices(session)
  return <ServiceNoticeDisclosure scope={`local-test:${id}`} notices={notices} complete={false}>
    {notices.map(item => <ServiceWindowNotice key={item.id} notice={item.notice} />)}
  </ServiceNoticeDisclosure>
}

it('keeps the original connection visible outside the inbox until its exact observation resolves', async () => {
  const pending = { hostId: 'local', step: 'Core to ctxmux connection', scope: 'observation' as const,
    availability: 'unverified' as const, code: 'CTXMUX_STARTUP_PENDING',
    message: 'The original daemon is awaiting readiness.', recovery: 'The same connection will complete when readiness arrives.',
    observationOrigin: { kind: 'runtime-connection' as const, boundary: 'core-ctxmux' as const } }
  const other = { ...pending, hostId: 'remote', message: 'Remote readiness is awaiting confirmation.' }
  useAppStore.setState({ runtimeEndpointWarnings: [pending, other], sessions: [agent('retained')] })
  const original = useAppStore.getState().sessions
  await dom.render(<GlobalSystemNotices />)
  const indicator = () => dom.container.querySelector<HTMLButtonElement>('.global-system-notices__connection')
  expect(indicator()?.textContent).toContain('Unconfirmed · ')
  expect(indicator()?.textContent).toContain('Core to ctxmux connection')
  expect(indicator()?.textContent).toContain('+1')
  expect(indicator()?.title).toContain(pending.message)
  expect(rows()).toHaveLength(0)
  await click('.global-system-notices__connection')
  await toggleNotificationCenter(dom.container, 'open')
  expect(dom.container.querySelector('[data-category="connections"]')?.getAttribute('aria-pressed')).toBe('true')
  await markShown()
  expect(rows().every(row => row.dataset.unread === 'false')).toBe(true)
  await toggleNotificationCenter(dom.container, 'closed')
  expect(indicator()).not.toBeNull()
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', event: { type: 'control-endpoint-state' }, hostId: 'remote',
    endpointObservation: { step: pending.step, warning: null } } as never))
  expect(indicator()?.textContent).not.toContain('+1')
  expect(indicator()?.title).toContain(pending.message)
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', event: { type: 'control-endpoint-state' }, hostId: 'local',
    endpointObservation: { step: 'Core control connection', warning: null } } as never))
  expect(indicator()).not.toBeNull()
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', event: { type: 'control-endpoint-state' }, hostId: 'local',
    endpointObservation: { step: pending.step, warning: null } } as never))
  expect(indicator()).toBeNull()
  expect(useAppStore.getState().sessions).toBe(original)
})

it('keeps a connection observation with unknown provenance visible without inventing its origin', async () => {
  useAppStore.setState({ runtimeEndpointWarnings: [{ hostId: 'local', scope: 'observation', availability: 'unverified',
    step: 'Connection observation source', code: 'CONTROL_PROTOCOL_ERROR', observationOrigin: null,
    message: 'The connection observation source is missing.', recovery: 'Observe the original connection again.' }] })
  await dom.render(<GlobalSystemNotices />)
  const indicator = dom.container.querySelector('.global-system-notices__connection')
  expect(indicator?.textContent).toContain('Unconfirmed · ')
  expect(indicator?.textContent).toContain('Connection observation source')
  expect(useAppStore.getState().runtimeEndpointWarnings?.[0]?.observationOrigin).toBeNull()
})

it('positions the original popover from its invoking bell independently of unrelated input surfaces', async () => {
  const position = vi.mocked(floating.computePosition), original = position.getMockImplementation()!
  position.mockResolvedValue({ x: 100, y: 200,
    placement: 'top-end', strategy: 'fixed', middlewareData: {} })
  try {
    useAppStore.setState({ environmentWarning: 'Original shell setup needs review.' })
    await dom.render(<><div className="agent-input-stack">Unrelated unsent input</div><GlobalSystemNotices /></>)
    await toggleNotificationCenter(dom.container, 'open')
    expect(position).toHaveBeenCalled()
    const [reference, panel, options] = position.mock.calls.at(-1)!
    expect(reference).toBe(notificationTrigger(dom.container))
    expect(panel).toBe(dom.container.querySelector('.global-system-notices__details'))
    expect(options).toMatchObject({ strategy: 'fixed', placement: 'top-end' })
    expect(panel.style.left).toBe('100px')
    expect(panel.style.top).toBe('200px')
    expect(dom.container.querySelector('.agent-input-stack')!.textContent).toBe('Unrelated unsent input')
  } finally { position.mockImplementation(original) }
})

it('keeps the compact problem and severity discoverable while full impact and recovery remain in exact Details', async () => {
  useAppStore.setState({ environmentWarning: 'Complete shell diagnostic and original environment.' })
  await dom.render(<GlobalSystemNotices />); await toggleNotificationCenter(dom.container, 'open')
  expect(rows()[0]!.textContent).toContain('Local shell environment is incomplete')
  expect(rows()[0]!.textContent).toContain('Degraded')
  expect(rows()[0]!.textContent).not.toContain('Complete shell diagnostic')
  await toggleNotificationDetails(rows()[0]!)
  expect(rows()[0]!.querySelector('.notification-item__original')!.textContent).toContain('Complete shell diagnostic and original environment.')
  expect(rows()[0]!.querySelector('.notification-item__original')!.textContent).toContain('Existing processes keep their original environment.')
  expect(useAppStore.getState().environmentWarning).toBe('Complete shell diagnostic and original environment.')
})

it('the problem itself is the details disclosure and reading stays scoped to that original item', async () => {
  useAppStore.setState({ sessions: [agent('disclosure-owner', 3)] })
  await dom.render(<GlobalSystemNotices />); await toggleNotificationCenter(dom.container, 'open')
  const first = rows()[0]!, disclosure = first.querySelector('summary')!
  expect(disclosure.querySelector('.notification-item__title')?.textContent).toBe('The original first prompt is unconfirmed')
  expect(disclosure.textContent).toContain('Unconfirmed')
  expect(disclosure.querySelector('button')).toBeNull()
  expect(first.querySelector('.notification-item__read')?.closest('.notification-item__reading')?.contains(disclosure)).toBe(true)
  expect(first.querySelector('.notification-item__original')).toBeNull()
  expect(unread()).toBe(3)
  await toggleNotificationDetails(first)
  expect(unread()).toBe(2)
  expect(first.querySelector('.notification-item__original')!.textContent).toContain('Its first prompt will not be sent again automatically.')
  expect(useAppStore.getState().sessions).toHaveLength(1)
  await expandGroups()
  expect(rows()).toHaveLength(3)
  expect(rows().filter(row => row.dataset.unread === 'true')).toHaveLength(2)
})

it('groups 98 current facts by exact objects without deleting independent issues or expanding all rows', async () => {
  const sessions = Array.from({ length: 32 }, (_, index) => agent(`owner-${index}`, 3))
  useAppStore.setState({ sessions, environmentWarning: 'Shell lookup did not finish.',
    sessionNameMetadataWarning: { code: 'NAME_OBSERVATION', message: 'Names could not be read.', recovery: 'Retry reading original names.' } as never })
  const original = useAppStore.getState().sessions
  await dom.render(<GlobalSystemNotices />)
  expect(unread()).toBe(98)
  expect(rows()).toHaveLength(0)
  await toggleNotificationCenter(dom.container, 'open')
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('98 current')
  expect(unread()).toBe(98)
  const objectGroups = groups().filter(group => group.querySelector('.notification-group__more'))
  expect(objectGroups).toHaveLength(32)
  expect(new Set(objectGroups.map(group => group.dataset.groupId)).size).toBe(32)
  expect(rows().length).toBeLessThan(98)
  await expandGroups()
  expect(rows()).toHaveLength(98)
  expect(useAppStore.getState().sessions).toBe(original)
})

it('opening, closing and changing filters never mark unseen current or activity records read', async () => {
  useAppStore.setState({ sessions: [agent('one')], environmentWarning: 'A system observation needs review.' })
  useAppStore.getState().reportError('An independent operation failed.')
  const records = useAppStore.getState().notificationEvents
  await dom.render(<GlobalSystemNotices />)
  const originalUnread = unread()
  expect(originalUnread).toBeGreaterThan(1)
  await toggleNotificationCenter(dom.container, 'open')
  await category('agents'); await category('all'); await section('history')
  await toggleNotificationCenter(dom.container, 'closed')
  expect(unread()).toBe(originalUnread)
  expect(useAppStore.getState().notificationEvents).toBe(records)
  expect(useAppStore.getState().noticeReadReceipts).toEqual({})
})

it('Mark shown read applies only to the selected view and category, including folded original issues', async () => {
  useAppStore.setState({ sessions: [agent('one', 3), agent('two', 3)], environmentWarning: 'Shell observation failed.' })
  useAppStore.getState().reportError('Operation activity remains unread.')
  await dom.render(<GlobalSystemNotices />)
  const original = unread()
  await toggleNotificationCenter(dom.container, 'open'); await category('agents')
  expect(rows()).toHaveLength(2)
  await markShown()
  expect(unread()).toBe(original - 6)
  await category('all')
  expect(rows().some(row => row.getAttribute('data-unread') === 'true')).toBe(true)
  await section('history')
  expect(rows()).toHaveLength(1)
  expect(rows()[0]!.getAttribute('data-unread')).toBe('true')
  await markShown()
  expect(unread()).toBe(original - 7)
  expect(useAppStore.getState().environmentWarning).toBe('Shell observation failed.')
  expect(useAppStore.getState().sessions).toHaveLength(2)
})

it('opening an original item Details marks only that version without clearing its cause', async () => {
  const sessions = [agent('one'), agent('two')]
  useAppStore.setState({ sessions, agentComposerDrafts: { one: 'Keep this unsent text', two: 'Independent draft' } })
  await dom.render(<GlobalSystemNotices />); await toggleNotificationCenter(dom.container, 'open')
  expect(rows()).toHaveLength(2)
  const id = rows()[0]!.dataset.noticeId
  await toggleNotificationDetails(rows()[0]!)
  expect(unread()).toBe(1)
  expect(rows().find(row => row.dataset.noticeId === id)!.dataset.unread).toBe('false')
  expect(rows()[1]!.dataset.unread).toBe('true')
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ one: 'Keep this unsent text', two: 'Independent draft' })
  await toggleNotificationCenter(dom.container, 'closed'); await toggleNotificationCenter(dom.container, 'open')
  expect(unread()).toBe(1)
  expect(rows()).toHaveLength(2)
})

it('a new item preserves the selected category and expanded original row and remains unread', async () => {
  useAppStore.getState().reportError('Original operation')
  await dom.render(<GlobalSystemNotices />); await toggleNotificationCenter(dom.container, 'open')
  await section('history'); await category('operations')
  await toggleNotificationDetails(rows()[0]!)
  const firstId = rows()[0]!.dataset.eventId
  await act(async () => useAppStore.getState().reportError('Later independent operation'))
  expect(dom.container.querySelector('[data-section="history"]')!.getAttribute('aria-selected')).toBe('true')
  expect(dom.container.querySelector('[data-category="operations"]')!.getAttribute('aria-pressed')).toBe('true')
  const retained = rows().find(row => row.dataset.eventId === firstId)!
  expect(retained.querySelector<HTMLDetailsElement>('details')!.open).toBe(true)
  expect(rows().filter(row => row.dataset.unread === 'true')).toHaveLength(1)
})

it('local and global views share one exact original service read receipt without crossing Sessions', async () => {
  useAppStore.setState({ sessions: [agent('one'), agent('two')] })
  await dom.render(<><GlobalSystemNotices /><LocalService id="one" /></>)
  await toggleNotificationCenter(dom.container, 'open')
  expect(unread()).toBe(2)
  await click('.service-disclosure > .service-disclosure__close')
  expect(unread()).toBe(1)
  expect(rows().filter(row => row.dataset.unread === 'false')).toHaveLength(1)
  const other = rows().find(row => row.dataset.unread === 'true')!
  await toggleNotificationDetails(other)
  expect(unread()).toBe(0)
  expect(useAppStore.getState().sessions).toHaveLength(2)
  expect(Object.keys(useAppStore.getState().noticeReadReceipts['global:sessions'] ?? {})).toHaveLength(2)
})

it('a preexisting exact local read replaces a stale shared receipt without repeating or losing another reading fact', async () => {
  const session = agent('original-read-owner'), other = agent('independent-owner')
  const notice = sessionServiceNotices(session)[0]!, fingerprint = serviceNoticeFingerprint(notice)
  expect(notice.readKey).toBeTruthy(); expect(notice.readOrigin).toBeTruthy()
  useAppStore.setState({ sessions: [session, other], noticeReadReceipts: {
    'global:sessions': { [notice.readKey!]: 'a-prior-version-of-this-original-notice' },
    [notice.readOrigin!.scope]: { [notice.readOrigin!.id]: fingerprint, unrelated: 'retained-local-reading-fact' },
    'independent-reading-scope': { original: 'retained-independent-reading-fact' }
  } })
  await dom.render(<LocalService id={session.id} />)
  expect(dom.container.querySelector('.service-disclosure')!.getAttribute('data-unread')).toBe('false')
  expect(useAppStore.getState().noticeReadReceipts['global:sessions']?.[notice.readKey!]).toBe(fingerprint)
  expect(useAppStore.getState().noticeReadReceipts[notice.readOrigin!.scope]).toEqual({ unrelated: 'retained-local-reading-fact' })
  expect(useAppStore.getState().noticeReadReceipts['independent-reading-scope']).toEqual({ original: 'retained-independent-reading-fact' })
  await dom.render(<><LocalService id={session.id} /><GlobalSystemNotices /></>)
  await toggleNotificationCenter(dom.container, 'open')
  expect(unread()).toBe(1)
  expect(rows().filter(row => row.dataset.unread === 'false')).toHaveLength(1)
  expect(useAppStore.getState().sessions).toEqual([session, other])
})

it('diagnostic time refresh stays read while changed cause and confirmed resolution recurrence are unread', async () => {
  const original = agent('one')
  useAppStore.setState({ sessions: [original] })
  await dom.render(<GlobalSystemNotices />); await toggleNotificationCenter(dom.container, 'open'); await markShown()
  expect(unread()).toBe(0)
  await act(async () => useAppStore.setState({ sessions: [{ ...original,
    nativeSourceObservation: { ...original.nativeSourceObservation, observedAt: 200 } }] }))
  expect(unread()).toBe(0)
  await act(async () => useAppStore.setState({ sessions: [{ ...original,
    nativeSourceObservation: { ...original.nativeSourceObservation, reason: 'New source ambiguity' } }] }))
  expect(unread()).toBe(1)
  await markShown()
  const { nativeSourceObservation: _resolved, ...healthy } = original
  await act(async () => useAppStore.setState({ sessions: [healthy] }))
  expect(rows()).toHaveLength(0)
  await act(async () => useAppStore.setState({ sessions: [original] }))
  expect(unread()).toBe(1)
})

it('unknown and degraded notices retain honest severity labels and exact navigation targets', async () => {
  const target = agent('target'), select = vi.fn()
  useAppStore.setState({ sessions: [target], environmentWarning: 'Shell setup is incomplete.', selectSession: select })
  await dom.render(<GlobalSystemNotices />); await toggleNotificationCenter(dom.container, 'open')
  expect(rows().map(row => row.dataset.kind)).toEqual(['process-degraded', 'indeterminate'])
  expect(rows()[0]!.textContent).toContain('Degraded')
  expect(rows()[1]!.textContent).toContain('Unconfirmed')
  const action = rows()[1]!.querySelector<HTMLButtonElement>('.notification-item__action')!
  await act(async () => action.click())
  expect(select).toHaveBeenCalledExactlyOnceWith('target')
  expect(useAppStore.getState().sessions[0]).toBe(target)
})

it('history cleaning never removes current facts and detail copying uses the complete original body', async () => {
  const original = 'Original diagnostic ' + 'long data '.repeat(80) + ' FINAL RECEIPT'
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  useAppStore.setState({ sessions: [agent('one')] })
  useAppStore.getState().reportError(original)
  await dom.render(<GlobalSystemNotices />); await toggleNotificationCenter(dom.container, 'open'); await section('history')
  expect(rows()).toHaveLength(1)
  expect(rows()[0]!.querySelector('.notification-item__original')).toBeNull()
  await toggleNotificationDetails(rows()[0]!)
  expect(rows()[0]!.querySelector('.notification-item__original')!.textContent).toContain('FINAL RECEIPT')
  await act(async () => rows()[0]!.querySelector<HTMLButtonElement>('.notification-item__original button')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(original)
  const clear = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => /Clear all read/u.test(button.textContent ?? ''))
  expect(clear).toBeTruthy()
  await act(async () => clear!.click())
  expect(useAppStore.getState().notificationEvents).toHaveLength(0)
  await section('current')
  expect(rows()).toHaveLength(1)
  expect(unread()).toBe(1)
})

it('uses one unread badge and reserves entry failure emphasis for an unread confirmed failure', async () => {
  useAppStore.getState().reportError('Observation remains unknown.', { kind: 'indeterminate' })
  await dom.render(<GlobalSystemNotices />)
  const trigger = notificationTrigger(dom.container)
  expect(trigger.querySelectorAll('svg')).toHaveLength(1)
  expect(trigger.querySelectorAll('.global-system-notices__badge')).toHaveLength(1)
  expect(trigger.getAttribute('data-attention')).toBe('quiet')
  await act(async () => useAppStore.getState().reportError('The original process exited.', { kind: 'agent-broken' }))
  expect(trigger.getAttribute('data-attention')).toBe('failure')
  await toggleNotificationCenter(dom.container, 'open'); await section('history')
  expect(rows()[0]!.dataset.kind).toBe('agent-broken')
  await act(async () => rows()[0]!.querySelector<HTMLButtonElement>('.notification-item__read')!.click())
  expect(unread()).toBe(1)
  expect(trigger.getAttribute('data-attention')).toBe('quiet')
  expect(useAppStore.getState().notificationEvents).toHaveLength(2)
})

it('connection category exposes the exact Host action independently of Agent and operation filters', async () => {
  const openHost = vi.fn(), warnings = [{ hostId: 'local', step: 'Reading connection', code: 'CONTROL_PROTOCOL_ERROR',
    message: 'The original control receipt is unavailable.', recovery: 'Read this Host again.', availability: 'unverified' as const }]
  useAppStore.setState({ sessions: [agent('one')], runtimeEndpointWarnings: warnings })
  await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn(), openHost }}><GlobalSystemNotices /></SettingsNavigation.Provider>)
  await toggleNotificationCenter(dom.container, 'open'); await category('connections')
  expect(rows()).toHaveLength(1)
  expect(rows()[0]!.dataset.kind).toBe('indeterminate')
  await act(async () => rows()[0]!.querySelector<HTMLButtonElement>('.notification-item__action')!.click())
  expect(openHost).toHaveBeenCalledExactlyOnceWith('local')
  expect(useAppStore.getState().runtimeEndpointWarnings).toBe(warnings)
  await category('operations')
  expect(rows()).toHaveLength(0)
  await category('agents')
  expect(rows()).toHaveLength(1)
})

it('Current and Activity support roving keyboard focus without changing read state', async () => {
  useAppStore.setState({ sessions: [agent('one')] })
  useAppStore.getState().reportError('Original unread operation')
  await dom.render(<GlobalSystemNotices />); await toggleNotificationCenter(dom.container, 'open')
  const tabs = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="tab"][data-section]')]
  expect(tabs).toHaveLength(2)
  expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1])
  tabs[0]!.focus()
  for (const [key, expected] of [['ArrowRight', 1], ['Home', 0], ['End', 1], ['ArrowLeft', 0]] as const) {
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(tabs[expected])
    expect(tabs[expected]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs.filter(tab => tab.tabIndex === 0)).toHaveLength(1)
    const content = dom.container.querySelector('[role="tabpanel"]')!
    expect(content.id).toBe(tabs[expected]!.getAttribute('aria-controls'))
    expect(content.getAttribute('aria-labelledby')).toBe(tabs[expected]!.id)
    expect(unread()).toBe(2)
  }
})

it('original lifecycle failures share local and global reads while retaining each recovery owner and independent Activity', async () => {
  const session = { ...composerSession('resume-owner'), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  const retryResume = vi.fn(), retryLaunch = vi.fn()
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Original resume draft' } })
  useAppStore.getState().reportError('The original Resume receipt is unavailable.', { kind: 'indeterminate',
    lifecycle: { step: 'resume', subject: session.control, lastProcessState: 'running' } })
  useAppStore.getState().reportError('The original launch receipt is unavailable.', { kind: 'indeterminate',
    lifecycle: { step: 'launch', regionId: 'original-launch-region', tabId: 'original-launch-tab' } })
  useAppStore.getState().reportError('An independent ordinary activity remains unread.')
  const records = useAppStore.getState().notificationEvents, resume = records[0]!, launch = records[1]!
  await dom.render(<><GlobalSystemNotices />
    <div data-local="resume"><AgentLifecycleFeedback owner={{ subject: session.control }} retry={retryResume} /></div>
    <div data-local="launch"><AgentLifecycleFeedback owner={{ regionId: 'original-launch-region' }} retry={retryLaunch} /></div>
  </>)
  await toggleNotificationCenter(dom.container, 'open')
  expect(unread()).toBe(3)
  expect(rows()).toHaveLength(2)
  await click('[data-local="resume"] .service-disclosure > .service-disclosure__close')
  expect(unread()).toBe(2)
  expect(rows().find(row => row.dataset.noticeId === resume.id)!.dataset.unread).toBe('false')
  expect(useAppStore.getState().noticeReadReceipts['global:events']?.[resume.id]).toBe('read')
  await toggleNotificationDetails(rows().find(row => row.dataset.noticeId === launch.id)!)
  expect(dom.container.querySelector('[data-local="launch"] .service-disclosure')!.getAttribute('data-unread')).toBe('false')
  expect(unread()).toBe(1)
  expect(useAppStore.getState().notificationEvents).toBe(records)
  expect(projectNotifications(records).current.map(record => record.id)).toEqual([resume.id, launch.id])
  expect(retryResume).not.toHaveBeenCalled(); expect(retryLaunch).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-local="resume"]')!.textContent).toContain('Retry Resume')
  expect(dom.container.querySelector('[data-local="launch"]')!.textContent).toContain('Retry Start agent')
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original resume draft')
  await section('history')
  expect(rows()).toHaveLength(1)
  expect(rows()[0]!.dataset.unread).toBe('true')
})
