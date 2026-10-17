// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConnectionSetupView } from '@agentmux/core/connections'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  await act(async () => root!.render(<ConnectionRequestTrace source={source} revision={revision} {...(setupView === undefined ? {} : { setupView })} />))
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
  const diagnosis = JSON.parse(clipboard.mock.calls[0]![0])
  expect(diagnosis).toEqual(result.requestTrace)
  expect(diagnosis.entries.at(-1).stepId).toBe(result.requestTrace!.entries.at(-1)!.stepId)
  expect(f.registration.mock.calls).toHaveLength(nativeCalls)
  expect(container.querySelectorAll('tbody tr')).toHaveLength(visibleEntries)
  expect(container.textContent).toContain('Complete sanitized trace copied.')
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
  expect(JSON.parse(clipboard.mock.calls[0]![0])).toEqual(result.requestTrace)
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
}, 30_000)

it.each(['unmount', 'switch', 'close', 'failure'] as const)('does not copy a held partial diagnosis after %s', async action => {
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
        if (action === 'failure') throw new Error('Fixture page unavailable')
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
    if (action === 'failure') expect(container.textContent).toContain('Could not copy the complete diagnosis')
    else expect(container.textContent).not.toContain('Copying…')
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
  const diagnosis = JSON.parse(clipboard.mock.calls[0]![0])
  expect(diagnosis.setupObservation).toEqual(expectedObservation(view))
  expect(diagnosis.entries).toHaveLength(1)
  expect(diagnosis.next).toBeNull()
  expect(clipboard.mock.calls[0]![0]).not.toMatch(/private-|qrCode|account|rawNativeBody|cookie|credential|draft|notes|actionId|stepId.*private/iu)
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
  const diagnosis = JSON.parse(clipboard.mock.calls[0]![0])
  expect(Object.keys(diagnosis)).toEqual(['operationId', 'entries', 'next'])
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
    expect(container.textContent).toContain('Reading the complete original trace')
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
  const copied = JSON.parse(clipboard.mock.calls[0]![0])
  expect(copied.entries.length).toBeGreaterThan(25)
  expect(copied.setupObservation).toEqual(observation)
  expect(copied.setupObservation.publication.review.issues).toEqual(['The original audience is unconfirmed'])
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
