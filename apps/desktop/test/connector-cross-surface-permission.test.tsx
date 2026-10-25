// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { openConnectedGroup } from './helpers/connector-header-navigation'
import { permissionActionsFixture } from '../../../packages/connectors/test/fixtures/permission-actions.js'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AttentionRequestPanel } from '../src/renderer/src/components/AttentionRequestPanel.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { retainConnectorRoomIntent, useAppStore } from '../src/renderer/src/store'
import { reduceRuntimeEvent } from '../src/renderer/src/lib/session-state.js'
import { api } from '../src/renderer/src/lib/api'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


async function disclosure(label: string) {
  if (document.querySelector('section[aria-label="' + label + '"]')) return
  const summary = [...document.querySelectorAll('summary')].find(node => node.textContent === label)!
  expect(summary, label).toBeDefined()
  if (!(summary.parentElement as HTMLDetailsElement).open) await act(async () => summary.click())
}
async function ready(text: string) { await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')?.textContent).toContain(text) }, { timeout: 6000 }) }
async function toggle(label: string) {
  const input = [...document.querySelectorAll('label')].find(node => node.textContent?.trim() === label)?.querySelector('input')!
  expect(input, label).not.toBeNull(); await act(async () => input.click())
}

describe('the original member access owner', () => {
  const f = connectorJourneyFixture({ platform: async request => {
    if (request.url?.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'ou_original', name: 'Ada' }], has_more: false } }
    if (request.url?.endsWith('/chats') || request.url?.endsWith('chats/search')) return { code: 0, data: { items: [{ chat_id: 'oc_original', name: 'Design team', chat_status: 'normal' }], has_more: false } }
    return { code: 0, data: { name: 'Design team', chat_status: 'normal', chat_mode: 'group' } }
  } })
  async function open() {
    await f.mount(); await f.journey('existing'); await f.fill('Existing group ID', 'oc_original')
    await act(async () => document.querySelector<HTMLInputElement>('.agent-connector-check input')!.click())
    await f.button('Connect group'); await ready('Group saved'); await disclosure('Member access')
    await f.fill('Member access ID type', 'open_id'); await f.fill('Member access ID', 'ou_original')
  }
  it('starts remote permission off, explicitly shares decision context for one member and revokes only that capability through trusted IPC/public CLI', async () => {
    await open()
    const permission = [...document.querySelectorAll('label')].find(node => node.textContent === 'Allow permission decisions')!.querySelector('input')!
    expect(permission.checked).toBe(false)
    await ready('original permission request and tool details with this group')
    await toggle('Send requests'); await toggle('Allow permission decisions'); await f.button('Approve this member')
    await ready('Permission decisions')
    const binding = (await f.services.connections.bindings!.list({})).bindings[0]!
    const read = await f.cli(['binding', 'inspect', '--binding', binding.bindingId])
    expect(read.grants[0]).toMatchObject({ actor: { idType: 'open_id', userId: 'ou_original' }, capabilities: ['input', 'permission'], revision: 1 })
    expect(f.calls.filter(value => value.method === 'connection.grant')).toHaveLength(1)
    await f.button('Revoke permission decisions')
    await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.grant' && call.result)).toHaveLength(2), { timeout: 6000 })
    expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).grants[0]).toMatchObject({ capabilities: ['input'], state: 'active', revision: 2 })
    expect(f.calls.filter(value => value.method === 'connection.grant')).toHaveLength(2)
    expect(f.platformCalls.some(call => call.method === 'POST')).toBe(false)
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
  }, 25_000)

  it.each(['selection', 'receipt'] as const)('keeps %s scoped to the current group while its original grant read is delayed', async phase => {
    const configured = (await f.services.connections.list()).connections[0]!.config
    await api.connections.call('connection.configure', { operationId: 'other-application-config', expectedRevision: null, connection: { ...configured, connectionId: 'other-application', application: { ...configured.application, appId: 'cli_1123456789abcdef' } } })
    const first = { ...f.original.input, operationId: 'first-member-group', bindingId: 'first-group', connectionId: configured.connectionId, externalConversationId: 'oc_first' }
    const second = { ...first, operationId: 'second-member-group', bindingId: 'second-group', connectionId: 'other-application', externalConversationId: 'oc_second' }
    expect((await api.connections.call('connection.bind', first)).state).toBe('applied')
    const bound = await api.connections.call('connection.bind', second)
    expect(bound.state).toBe('applied')
    await api.connections.call('connection.grant', { operationId: 'first-member-grant', bindingId: first.bindingId, expectedBindingRevision: 1, grantId: 'first-member', expectedRevision: null,
      actor: { application: configured.application, idType: 'open_id', userId: 'ou_original' }, capabilities: ['permission'], state: 'active' })
    await f.mount()
    await openConnectedGroup('oc_first'); await ready('Revoke permission decisions')
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve }), forward = f.forward
    vi.spyOn(api.connections, 'call').mockImplementation(async (method, input) => {
      const result = await forward(method, input)
      if (method === 'connection.binding.inspect' && 'bindingId' in input && input.bindingId === second.bindingId) await barrier
      return result
    })
    try {
      const trigger = document.querySelector<HTMLElement>('[aria-label="Group application"]')!
      await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
      const option = document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="other-application"]')!
      expect(option).not.toBeNull(); await act(async () => option.click())
      await disclosure('People in this group'); await f.button('Choose')
      const permission = [...document.querySelectorAll('label')].find(node => node.textContent === 'Allow permission decisions')!.querySelector('input')!
      if (phase === 'selection') expect(permission.checked, 'Another application grant cannot opt this group into permission sharing').toBe(false)
      else {
        if (!permission.checked) await toggle('Allow permission decisions')
        await f.button('Approve this member')
        await vi.waitFor(async () => { await act(async () => {}); expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Revoke permission decisions'), 'The exact current applied grant remains visible while its initial read is pending').toBe(true) })
        const read = await f.cli(['binding', 'inspect', '--binding', second.bindingId])
        expect(read.grants).toHaveLength(1); expect(read.grants[0]).toMatchObject({ actor: { application: bound.state === 'applied' ? bound.binding.application : {} }, capabilities: ['permission'] })
        await f.button('Revoke permission decisions')
        await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.grant' && call.result)).toHaveLength(3), { timeout: 6000 })
        expect((await f.cli(['binding', 'inspect', '--binding', second.bindingId])).grants[0].state).toBe('revoked')
      }
      expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
    } finally { await act(async () => release()) }
  }, 25_000)

  it.each(['approve', 'revoke'] as const)('keeps a previous group grant wait from taking the next group member %s action', async action => {
    await open(); await toggle('Allow permission decisions')
    const forward = f.forward; let previousOperation = '', release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(api.connections, 'call').mockImplementation(async (method, input) => {
      const previousGrant = method === 'connection.grant' && 'expectedBindingRevision' in input && input.expectedBindingRevision === 1
      if (previousGrant) previousOperation = input.operationId
      if (method === 'connection.binding.inspect' && 'operationId' in input && input.operationId === previousOperation) await barrier
      const result = await forward(method, input)
      if (previousGrant) throw Error('Controlled lost previous group grant receipt')
      return result
    })
    try {
      await f.button('Approve this member')
      await vi.waitFor(async () => {
        await act(async () => {})
        expect(previousOperation).not.toBe('')
        expect(useAppStore.getState().connectorRoomIntents[previousOperation]).toMatchObject({ method: 'connection.grant', phase: 'may-have-dispatched' })
        expect(document.querySelector('[aria-label="Member access status"] strong')?.textContent).toBe('Member access not confirmed')
      }, { timeout: 6000 })
      const binding = (await f.services.connections.bindings!.list({})).bindings[0]!
      await f.button('Close')
      const relink = await forward('connection.binding.relink', { ...f.original.input, operationId: 'member-next-group', bindingId: binding.bindingId, expectedRevision: 1,
        connectionId: f.config.connectionId, expectedConnectionRevision: 1, externalConversationId: 'oc_next' })
      expect(relink.state).toBe('applied')
      if (action === 'revoke') {
        const original = f.calls.find(call => call.method === 'connection.grant')!.input as import('@agentmux/core/connections').RoomBindingGrantInput
        expect((await forward('connection.grant', { ...original, operationId: 'member-reassigned-current-group', expectedBindingRevision: 2, expectedRevision: 1 })).state).toBe('applied')
      }
      await f.journey('details'); await disclosure('People in this group'); await f.button('Choose')
      const earlier = document.querySelector('[aria-label="Member access status"]')!
      expect(earlier).not.toBeNull(); expect(earlier.querySelector('strong')?.textContent).toBe('Member access not confirmed')
      const originalScope = [...earlier.querySelectorAll('span')].find(node => node.textContent === 'Original group connection · revision 1')
      expect(originalScope, 'The old request identifies its own group revision before opening details').toBeDefined(); expect(originalScope!.closest('details')).toBeNull()
      if (action === 'approve') {
        await toggle('Allow permission decisions'); await f.button('Approve this member')
        await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.grant'), 'A wait for revision one cannot take a new revision two action').toHaveLength(2))
      }
      await vi.waitFor(async () => { await act(async () => {}); const revoke = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Revoke permission decisions'); expect(revoke, 'The applied current group receipt remains usable').toBeDefined(); expect(revoke!.disabled, 'An older group read cannot hold the applied current grant').toBe(false) })
      const read = await f.cli(['binding', 'inspect', '--binding', binding.bindingId])
      expect(read.grants[0]).toMatchObject({ bindingRevision: 2, capabilities: ['permission'] })
      expect(Object.values(useAppStore.getState().connectorRoomIntents).some(intent => intent.input.operationId === previousOperation)).toBe(true)
      await f.button('Revoke permission decisions')
      await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.grant'), 'Revocation uses the current group revision even with an older intent for the same grant ID').toHaveLength(3))
      await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.grant' && call.result)).toHaveLength(3), { timeout: 6000 })
      expect((await f.cli(['binding', 'inspect', '--binding', binding.bindingId])).grants[0].state).toBe('revoked')
      expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
    } finally { await act(async () => release()) }
  }, 25_000)

  it.each(['empty', 'approved'] as const)('keeps an %s last-confirmed member snapshot distinct from its original unconfirmed request', async baseline => {
    await open()
    if (baseline === 'approved') { await toggle('Send requests'); await f.button('Approve this member'); await ready('Requests') }
    await toggle('Allow permission decisions')
    const forward = f.forward
    vi.spyOn(api.connections, 'call').mockImplementation(async (method, input) => {
      const result = await forward(method, input)
      if (method === 'connection.grant' && 'actor' in input && input.actor.userId === 'ou_original') throw new Error('Controlled lost original member access receipt')
      return result
    })
    await f.button(baseline === 'approved' ? 'Save member access' : 'Approve this member'); await ready('Member access not confirmed')
    const original = Object.values(useAppStore.getState().connectorRoomIntents)[0]!
    expect(original.method).toBe('connection.grant')
    const summary = document.querySelector('[aria-label="Group member access"]')!
    expect(summary.textContent).toContain('Member access not confirmed')
    expect(summary.textContent).toContain('Last confirmed:')
    expect(summary.textContent).toContain(baseline === 'approved' ? '1 member approved' : 'no members approved')
    const access = document.querySelector<HTMLElement>('section[aria-label="Member access"]')!
    expect(access, 'original member access remains directly visible').not.toBeNull()
    if (baseline === 'approved') expect(access.textContent).toContain('Last confirmed:')
    await vi.waitFor(async () => { await act(async () => {}); expect([...access.querySelectorAll('button')].map(node => node.textContent)).toContain('Check original member access') })
    expect([...access.querySelectorAll('button')].some(node => node.textContent === 'Approve this member' || node.textContent === 'Save member access')).toBe(false)
    const before = f.calls.filter(call => call.method === 'connection.grant').length
    await f.fill('Member access ID', 'ou_other'); await toggle('Answer questions'); await f.button('Approve this member')
    await ready('Answers')
    expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(before + 1)
    const binding = (await f.services.connections.bindings!.list({})).bindings[0]!
    const current = await f.cli(['binding', 'inspect', '--binding', binding.bindingId])
    expect(current.grants.find((grant: { actor: { userId: string } }) => grant.actor.userId === 'ou_other')).toMatchObject({ capabilities: ['answer'], state: 'active' })
    expect(current.grants.find((grant: { actor: { userId: string } }) => grant.actor.userId === 'ou_original')).toMatchObject({ capabilities: baseline === 'approved' ? ['input', 'permission'] : ['permission'], state: 'active' })
    expect(document.querySelector('[aria-label="Group member access"]')?.textContent).toContain('Member access not confirmed')
    await f.fill('Member access ID', 'ou_original'); await f.button('Check original member access')
    await vi.waitFor(() => expect(useAppStore.getState().connectorRoomIntents[original.input.operationId]).toBeUndefined())
    await ready('Permission decisions')
    expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(before + 1)
    expect(f.calls.some(call => call.method === 'connection.binding.inspect' && (call.input as { operationId?: string }).operationId === original.input.operationId)).toBe(true)
    expect(document.querySelector('[aria-label="Group member access"]')?.textContent).not.toContain('not confirmed')
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中'); await f.original.unchanged()
  }, 25_000)

  it('keeps a positively unsent member request distinct from an unknown effect and continues its exact original input', async () => {
    await open()
    const binding = (await f.services.connections.bindings!.list({})).bindings[0]!
    const input = { operationId: 'original-unsent-member', bindingId: binding.bindingId, expectedBindingRevision: binding.revision, grantId: 'original-unsent-grant', expectedRevision: null,
      actor: { application: binding.application, idType: 'open_id', userId: 'ou_original' }, capabilities: ['input' as const], state: 'active' as const }
    await act(async () => { const saved = await retainConnectorRoomIntent({ method: 'connection.grant', target: { executionHostId: binding.executionHostId, agentSessionId: binding.agentSessionId, regionAnchor: binding.regionAnchor }, phase: 'not-dispatched', input }); expect(saved.localStorageWritten).toBe(true) })
    await ready('Member access not sent')
    expect(document.querySelector('[aria-label="Group member access"]')?.textContent).toBe('No members approved to use this Agent')
    expect(f.calls.filter(call => call.method === 'connection.grant')).toHaveLength(0)
    await f.button('Continue setup'); await ready('Requests')
    expect(f.calls.filter(call => call.method === 'connection.grant').map(call => call.input)).toEqual([input])
    expect(useAppStore.getState().connectorRoomIntents[input.operationId]).toBeUndefined()
  }, 25_000)

  it('retains the original grant intent after a lost IPC receipt and only inspects it', async () => {
    await open(); await toggle('Allow permission decisions')
    const forward = f.forward
    let originalOperation = '', inspectionAvailable = false
    vi.spyOn(api.connections, 'call').mockImplementation(async (method, input) => {
      if (method === 'connection.grant') originalOperation = input.operationId
      if (method === 'connection.binding.inspect' && 'operationId' in input && input.operationId === originalOperation && !inspectionAvailable) throw new Error('Controlled original member access observation failure')
      const result = await forward(method, input)
      if (method === 'connection.grant') throw new Error('Controlled lost member grant receipt')
      return result
    })
    await f.button('Approve this member'); await ready('Member access not confirmed')
    const intents = Object.values(useAppStore.getState().connectorRoomIntents)
    expect(intents).toHaveLength(1)
    const original = intents[0]!
    expect(original).toMatchObject({ method: 'connection.grant', phase: 'may-have-dispatched', input: { operationId: originalOperation } })
    await f.button('Close'); await f.journey('details'); await ready('Member access not confirmed')
    expect(useAppStore.getState().connectorRoomIntents[originalOperation]).toEqual(original)
    expect(document.querySelector('[aria-label="Member access status"] strong')?.textContent).toBe('Member access not confirmed')
    inspectionAvailable = true
    await f.button('Check status'); await ready('Permission decisions')
    await vi.waitFor(() => expect(useAppStore.getState().connectorRoomIntents[originalOperation]).toBeUndefined())
    expect(f.calls.filter(value => value.method === 'connection.grant')).toHaveLength(1)
    expect(f.calls.some(value => value.method === 'connection.binding.inspect' && (value.input as { operationId?: string }).operationId === original.input.operationId)).toBe(true)
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
  }, 25_000)
})

describe('the original Desktop card and Hosted execution owner', () => {
  const dom = composerDOM(), cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
  async function open() {
    const f = await permissionActionsFixture(); cleanup.push(() => f.close())
    await f.grant(); const original = await f.open()
    const session = { ...composerSession('original-agent'), pendingInteraction: original.request, agentSessionUpdatedAt: _historyFixtureEpoch(0, 0, 0) }
    useAppStore.setState({ sessions: [session], agentComposerDrafts: { 'original-agent': 'Retain this exact draft 中' } })
    cleanup.push(f.hosted.onEvent(event => { act(() => useAppStore.setState(reduceRuntimeEvent(useAppStore.getState(), { type: 'core', hostId: 'local', event }))) }))
    const runtime = Object.create(RuntimeController.prototype) as RuntimeController
    Object.assign(runtime, { hostReconfigurationReservations: new Map(), hostOperations: new Map(), configuredClient: () => f.hosted })
    vi.spyOn(api.sessions, 'respondInteraction').mockImplementation((control, response, intent) => runtime.respondInteraction(control, response, intent))
    vi.spyOn(api.sessions, 'inspectInteraction').mockImplementation((control, operationId) => runtime.inspectInteraction(control, operationId))
    const submit = vi.spyOn(useAppStore.getState(), 'respondInteraction')
    await dom.render(<AttentionRequestPanel sessionId="original-agent" onClose={() => {}} />)
    await vi.waitFor(() => expect(f.buttons().length).toBeGreaterThan(0), { timeout: 8_000 })
    return { ...f, originalRequest: original, submit }
  }
  it('an original Desktop decision reaches the real Hook and updates its exact SDK card without pretending Native completion', async () => {
    const f = await open(), label = f.originalRequest.request.kind === 'permission' ? f.originalRequest.request.options.find(option => option.id === 'reject-once')!.label : ''
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!
    expect(button).toBeDefined(); await act(async () => { button.click(); await f.submit.mock.results[0]!.value })
    await expect(f.originalRequest.callback).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Native adoption') })
    await vi.waitFor(() => expect(f.effects.some(value => value.method === 'PATCH')).toBe(true))
    expect(f.buttons()).toEqual([])
    expect(f.effects.filter(value => value.method === 'POST')).toHaveLength(1)
    expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Retain this exact draft 中')
  }, 25_000)
  it('an authenticated group decision updates the mounted original Desktop request through its existing event reducer', async () => {
    const f = await open(), button = f.buttons().find(value => /deny|reject/i.test(value.text.content))!
    await act(async () => { await f.sdk.receive(f.action(button.value.actionRef)); await f.originalRequest.callback })
    await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Native adoption') })
    expect(dom.container.querySelector('pre')?.textContent).toContain('original command')
    expect([...dom.container.querySelectorAll('button')].some(node => /deny|reject/i.test(node.textContent ?? '') && !(node as HTMLButtonElement).disabled)).toBe(false)
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Retain this exact draft 中')
    expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
  }, 25_000)
})
