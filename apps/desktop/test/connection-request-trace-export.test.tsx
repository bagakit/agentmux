// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConnectionSetupView } from '@agentmux/core/connections'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { diagnosisText } from './helpers/connection-diagnosis-text'
import { createClientUiRoot } from './helpers/client-ui-render'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'
import { ConnectionRequestTrace, type ConnectionTraceSource } from '../src/renderer/src/components/settings/ConnectionRequestTrace'
import { api } from '../src/renderer/src/lib/api'

let f: Awaited<ReturnType<typeof moteBotUi>>, root: Root | null, container: HTMLDivElement
beforeEach(async () => {
  f = await moteBotUi()
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container.remove(); await f.close()
})
async function originalTrace(kind: ConnectionTraceSource['kind'], polls = 30) {
  const input = await f.input('trace-parent-' + kind)
  let parent = await f.client.call('space.mote.connection.create', input)
  if (kind === 'setup') parent = await confirmAndCreateMote(f, input.operationId)
  const transport = f.registration.getMockImplementation()!
  f.registration.mockImplementation(async (url, input) => new URL(url instanceof Request ? url.url : String(url)).pathname === '/accounts/qrlogin/polling'
    ? Response.json({ code: 0, data: { next_step: 'qr_login_polling', step_info: { status: 1 } } })
    : transport(url, input))
  const source: ConnectionTraceSource = { kind, operationId: kind === 'setup' ? 'trace-export-setup' : parent.enrollmentOperationId! }
  if (kind === 'setup') {
    let view = await api.connections.call('connection.setup.begin', { operationId: source.operationId, connectionId: parent.connection!.connectionId, expectedConnectionRevision: 1, goal: { kind: 'agent-conversation', interaction: 'messages' } })
    for (let index = 0; index < polls; index++) {
      const action = view.continuation!.actions.find(action => action.kind === 'continue')!
      expect(action).toBeDefined()
      view = await api.connections.call('connection.setup.advance', { operationId: source.operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'continue' } })
    }
  } else {
    let view = await api.connections.call('connection.enrollment.inspect', { operationId: source.operationId })
    for (let index = 0; index < 30; index++) {
      const action = view.actions.find(action => action.kind === 'continue-authentication')!
      expect(action).toBeDefined()
      view = await api.connections.call('connection.enrollment.advance', { operationId: source.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: action.kind } })
    }
  }
  return source
}
async function render(source: ConnectionTraceSource, setupView?: ConnectionSetupView | null, revision?: number) {
  await act(async () => root!.render(<ConnectionRequestTrace hostingTarget={f.hostingTarget} source={source} revision={revision} {...(setupView === undefined ? {} : { setupView })} />))
}
async function open(source: ConnectionTraceSource, visibleEntries = 25, setupView?: ConnectionSetupView | null) {
  await render(source, setupView)
  await act(async () => container.querySelector<HTMLElement>('summary')!.click())
  await vi.waitFor(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(visibleEntries))
}
async function copy() {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Copy diagnosis')!
  expect(button).toBeDefined()
  await act(async () => button.click())
}

it.each(['setup', 'enrollment'] as const)('copies the complete original %s trace through registered IPC without platform calls', async kind => {
  const source = await originalTrace(kind)
  const result = kind === 'setup'
    ? await api.connections.call('connection.setup.inspect', { operationId: source.operationId, requestTrace: { limit: 100 } })
    : await api.connections.call('connection.enrollment.inspect', { operationId: source.operationId, requestTrace: { limit: 100 } })
  expect(result.requestTrace!.entries.length).toBeGreaterThan(kind === 'setup' ? 25 : 0)
  expect(result.requestTrace!.next).toBeNull()
  const visibleEntries = Math.min(25, result.requestTrace!.entries.length)
  await open(source, visibleEntries)
  const nativeCalls = f.registration.mock.calls.length
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const diagnosis = diagnosisText(clipboard.mock.calls[0]![0])
  expect(diagnosis.traces[0]).toEqual({ kind, operationId: source.operationId, status: 'complete', entries: result.requestTrace!.entries })
  expect(diagnosis.traces[0]!.entries.at(-1).stepId).toBe(result.requestTrace!.entries.at(-1)!.stepId)
  expect(f.registration.mock.calls).toHaveLength(nativeCalls)
  expect(container.querySelectorAll('tbody tr')).toHaveLength(visibleEntries)
  expect(container.textContent).toContain('Diagnosis copied with unavailable sections')
  expect(clipboard.mock.calls[0]![0]).not.toMatch(/private-mote|mote-session|csrf|https?:\/\/|pngDataUrl/iu)
}, 30_000)

it('copies original steps recorded after the visible page was read', async () => {
  const source = await originalTrace('setup', 0)
  await open(source, 1)
  const view = await api.connections.call('connection.setup.inspect', { operationId: source.operationId })
  const action = view.continuation!.actions.find(action => action.kind === 'continue')!
  await api.connections.call('connection.setup.advance', { operationId: source.operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'continue' } })
  const result = await api.connections.call('connection.setup.inspect', { operationId: source.operationId, requestTrace: { limit: 100 } })
  expect(result.requestTrace!.entries).toHaveLength(2)
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  expect(diagnosisText(clipboard.mock.calls[0]![0]).traces[0]!.entries).toEqual(result.requestTrace!.entries)
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
}, 30_000)

it.each(['unmount', 'switch', 'close'] as const)('does not copy a held partial diagnosis after %s', async action => {
  const source = await originalTrace('setup')
  await open(source)
  const forward = f.connectionCalls.getMockImplementation()!
  let arrive!: () => void, release!: () => void, finish!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve }), returned = new Promise<void>(resolve => { finish = resolve })
  f.connectionCalls.mockImplementation(async (method, input) => {
    if ('requestTrace' in input && input.requestTrace?.cursor) {
      arrive()
      try {
        await held
        return await forward(method, input)
      } finally { finish() }
    }
    return forward(method, input)
  })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  try {
    await arrived
    expect(clipboard).not.toHaveBeenCalled()
    if (action === 'unmount') { await act(async () => root!.unmount()); root = null }
    else if (action === 'switch') await render({ kind: 'setup', operationId: 'different-original-request' })
    else if (action === 'close') await act(async () => container.querySelector<HTMLElement>('summary')!.click())
  } finally {
    await act(async () => {
      release(); await returned
      await new Promise<void>(resolve => setImmediate(resolve))
    })
  }
  await vi.waitFor(() => {
    expect(container.textContent).not.toContain('Reading the complete original task')
  })
  expect(clipboard).not.toHaveBeenCalled()
}, 30_000)


async function diagnosticView(source: ConnectionTraceSource): Promise<ConnectionSetupView> {
  const original = await api.connections.call('connection.setup.inspect', { operationId: source.operationId })
  // A presentation DTO with deliberately sensitive extra facts checks that copying never serializes the view.
  return {
    ...original,
    operation: { ...original.operation!, goal: { kind: 'profile-update', desired: { name: 'private-profile-name', description: 'private-profile-description' }, publication: { notes: 'private-publication-notes' } } },
    challenge: { ...original.challenge!, qrPayload: 'private-qr-payload' },
    continuation: { ...original.continuation!, account: { userId: 'private-account-id', tenantId: 'private-tenant-id' } },
    profileUpdate: { stage: 'publication-create', state: 'attention', versionId: 'original-public-version', actions: [{ kind: 'refresh-publication-checks', actionId: 'private-action-id', expectedRevision: original.operation!.revision }], publicationDraft: { kind: 'create-version', version: '1.0.1', notes: 'private-draft-notes', visibility: 'current' } },
    applicationConfiguration: { effect: 'create-application-version', subject: 'publication-pending', effects: [], next: null, selected: null, capability: 'unknown', actions: [], reason: 'source-unconfirmed', draft: { kind: 'create-version', version: '1.0.1', notes: 'private-configuration-notes', visibility: 'current' }, review: { versions: [], selectedVersion: null, changes: [], audience: null, proposedAudience: null, entries: null, sharing: null, reasonRequired: null, creatorAudienceAvailable: false, issues: ['The original audience is unconfirmed'] }, requiredSubjects: ['publication-visibility'], sources: { visibility: { stepId: 'private-source-step', subject: 'publication-visibility', request: 'confirmed', secureStorage: 'stored', input: { operationId: source.operationId, expectedRevision: original.operation!.revision, decision: { actionId: 'private-read-action', value: 'continue' } } } } },
    ...{ rawNativeBody: { cookie: 'private-cookie', credentials: 'private-credential' } }
  }
}
function expectedObservation(view: ConnectionSetupView) {
  return {
    scope: 'single-view-observation', operationId: view.operation!.operationId, revision: view.operation!.revision,
    profileUpdate: { stage: 'publication-create', state: 'attention', versionId: 'original-public-version', actionKinds: ['refresh-publication-checks'] },
    publication: { capability: 'unknown', reason: 'source-unconfirmed', review: { issues: ['The original audience is unconfirmed'] }, sources: [{ subject: 'publication-visibility', request: 'confirmed', secureStorage: 'stored' }] }
  }
}

it('copies only the matching setup observation whitelist beside the complete original journal', async () => {
  const source = await originalTrace('setup', 0), view = await diagnosticView(source)
  await open(source, 1, view)
  const nativeCalls = f.registration.mock.calls.length, clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const diagnosis = diagnosisText(clipboard.mock.calls[0]![0])
  expect(diagnosis.observations['setup:' + source.operationId].setupObservation).toEqual(expectedObservation(view))
  expect(diagnosis.traces[0]!.entries).toHaveLength(1)
  expect(diagnosis.traces[0]!.status).toBe('complete')
  expect(clipboard.mock.calls[0]![0]).not.toMatch(/private-|qrCode|rawNativeBody|cookie|draft|notes|actionId|stepId.*private/iu)
  expect(f.registration.mock.calls).toHaveLength(nativeCalls)
  expect(container.textContent).toContain('one observed setup snapshot')
}, 30_000)

it.each(['foreign', 'missing', 'enrollment'] as const)('keeps the original export shape without a matching setup snapshot: %s', async kind => {
  const source = await originalTrace(kind === 'enrollment' ? 'enrollment' : 'setup', 0)
  const view = kind === 'enrollment' ? { operation: { operationId: 'unrelated-setup', revision: 1 }, challenge: null } as ConnectionSetupView : await diagnosticView(source)
  if (kind === 'foreign') view.operation!.operationId = 'different-setup'
  const visibleEntries = kind === 'enrollment' ? Math.min(25, (await api.connections.call('connection.enrollment.inspect', { operationId: source.operationId, requestTrace: { limit: 100 } })).requestTrace!.entries.length) : 1
  await open(source, visibleEntries, kind === 'missing' ? null : view)
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const diagnosis = diagnosisText(clipboard.mock.calls[0]![0])
  expect(diagnosis.observations[kind === 'enrollment' ? 'enrollment:' + source.operationId : 'setup:' + source.operationId].status).toBe('recorded')
  expect(clipboard.mock.calls[0]![0]).not.toContain('private-')
}, 30_000)

it('freezes one setup observation at click while later pages and new progress arrive separately', async () => {
  const source = await originalTrace('setup'), view = await diagnosticView(source), observation = expectedObservation(view)
  await open(source, 25, view)
  const forward = f.connectionCalls.getMockImplementation()!
  let arrive!: () => void, release!: () => void, finish!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve }), returned = new Promise<void>(resolve => { finish = resolve })
  f.connectionCalls.mockImplementation(async (method, input) => {
    if ('requestTrace' in input && input.requestTrace?.cursor) {
      arrive()
      try { await held; return await forward(method, input) } finally { finish() }
    }
    return forward(method, input)
  })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  try {
    await arrived
    expect(clipboard).not.toHaveBeenCalled()
    const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Copy diagnosis')!
    expect(button).toBeDefined()
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain('Reading the complete original task')
    const newer = structuredClone(view)
    newer.operation!.revision++
    newer.profileUpdate!.stage = 'publication-status'
    newer.profileUpdate!.state = 'complete'
    newer.profileUpdate!.actions = []
    await render(source, newer)
    // A mutable caller cannot revise the already-selected observation either.
    view.profileUpdate!.state = 'complete'
    if (view.applicationConfiguration?.effect === 'create-application-version') view.applicationConfiguration.review!.issues.push('A later observation issue')
  } finally { await act(async () => { release(); await returned }) }
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const copied = diagnosisText(clipboard.mock.calls[0]![0])
  expect(copied.traces[0]!.entries.length).toBeGreaterThan(25)
  expect(copied.observations['setup:' + source.operationId].setupObservation).toEqual(observation)
  expect(copied.observations['setup:' + source.operationId].setupObservation.publication.review.issues).toEqual(['The original audience is unconfirmed'])
}, 30_000)


it('keeps the recorded trace count and table nodes through a held revision refresh', async () => {
  const source = await originalTrace('setup', 0)
  await open(source, 1)
  const row = container.querySelector('tbody tr'), forward = f.connectionCalls.getMockImplementation()!
  let arrive!: () => void, release!: () => void, finish!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve }), returned = new Promise<void>(resolve => { finish = resolve })
  f.connectionCalls.mockImplementation(async (method, input) => {
    if ('requestTrace' in input) {
      arrive()
      try { await held; return await forward(method, input) } finally { finish() }
    }
    return forward(method, input)
  })
  try {
    await render(source, undefined, 1)
    await arrived
    const summary = container.querySelector('summary')!
    expect(summary.textContent).toContain('1 steps')
    expect(summary.textContent).not.toContain('Reading…')
    expect(summary.getAttribute('aria-busy')).toBe('true')
    expect(summary.querySelector('[data-semantic-icon="status.loading"]')).not.toBeNull()
    expect(container.querySelector('tbody tr')).toBe(row)
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).toContain('Refresh trace')
  } finally { await act(async () => { release(); await returned }) }
  await vi.waitFor(() => expect(container.querySelector('summary')!.getAttribute('aria-busy')).toBe('false'))
  expect(container.querySelector('tbody tr')).toBe(row)
}, 30_000)

it('marks a failed later page unavailable while retaining the exact observed setup and no partial history', async () => {
  const source = await originalTrace('setup'), forward = f.connectionCalls.getMockImplementation()!
  await render(source)
  f.connectionCalls.mockImplementation(async (method, input) => {
    if ('requestTrace' in input && input.requestTrace?.cursor) throw new Error('private later page failure')
    return forward(method, input)
  })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy(); await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const report = diagnosisText(clipboard.mock.calls[0]![0])
  expect(report.complete).toBe(false)
  expect(report.observations['setup:' + source.operationId].status).toBe('recorded')
  expect(report.traces).toEqual([{ kind: 'setup', operationId: source.operationId, status: 'unavailable', entries: [] }])
  expect(clipboard.mock.calls[0]![0]).not.toContain('private later page')
  expect(container.textContent).toContain('report is incomplete')
}, 30_000)

it('cancels a collapsed copy while a later original page is held', async () => {
  const source = await originalTrace('setup'), forward = f.connectionCalls.getMockImplementation()!
  await render(source)
  let arrive!: () => void, release!: () => void, finish!: () => void
  const arrived = new Promise<void>(resolve => { arrive = resolve }), held = new Promise<void>(resolve => { release = resolve }), returned = new Promise<void>(resolve => { finish = resolve })
  f.connectionCalls.mockImplementation(async (method, input) => {
    if ('requestTrace' in input && input.requestTrace?.cursor) { arrive(); try { await held; return await forward(method, input) } finally { finish() } }
    return forward(method, input)
  })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await copy()
  try {
    await arrived
    expect(container.querySelector<HTMLDetailsElement>('details')!.open).toBe(false)
    await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Cancel copy')!.click())
  } finally { await act(async () => { release(); await returned }) }
  expect(clipboard).not.toHaveBeenCalled(); expect(container.textContent).toContain('Diagnosis copy canceled.')
}, 30_000)


it('distinguishes a retained task with an unloaded trace from a setup that has not started', async () => {
  const localReads = f.connectionCalls.mock.calls.length, platformRequests = f.registration.mock.calls.length
  for (const diagnosisTarget of [
    { kind: 'mote', operationId: 'retained-parent', sourceTarget: null },
    { kind: 'enrollment', operationId: 'retained-enrollment' }
  ] as const) {
    await act(async () => root!.render(<ConnectionRequestTrace hostingTarget={f.hostingTarget} source={null} diagnosisTarget={diagnosisTarget} />))
    expect(container.querySelector('summary')!.textContent).toContain('Trace not loaded')
    expect(container.textContent).toContain('The original task is kept. Its trace is not loaded yet.')
    expect(container.textContent).not.toContain('No request yet')
    expect(container.textContent).not.toContain('Requests will appear here when this setup starts.')
    expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Copy diagnosis')!.disabled).toBe(false)
  }
  await act(async () => root!.render(<ConnectionRequestTrace hostingTarget={f.hostingTarget} source={null} />))
  expect(container.querySelector('summary')!.textContent).toContain('No request yet')
  expect(container.textContent).toContain('Requests will appear here when this setup starts.')
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Copy diagnosis')!.disabled).toBe(true)
  expect(f.connectionCalls.mock.calls).toHaveLength(localReads)
  expect(f.registration.mock.calls).toHaveLength(platformRequests)
})
