// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { useAppStore } from '../src/renderer/src/store'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'

let f: Awaited<ReturnType<typeof moteBotUi>>
beforeEach(async () => { f = await moteBotUi() })
afterEach(async () => { await f?.close() })
async function text(value: string) { await vi.waitFor(async () => { await f.settle(); expect(document.body.textContent).toContain(value) }, { timeout: 4000 }) }
const original = () => f.parentCalls.mock.calls.find(([m]) => m === 'space.mote.connection.create')![1] as any
async function create(code = true) { await f.open(); await text('Saved public name'); await f.click('Create a bot for this Mote'); if (code) await text('Scan to sign in') }
async function confirmAndCreate() {
  const parent = (await f.client.call('space.mote.connection.inspect', { operationId: original().operationId })).operation!
  let view = await f.client.call('connection.enrollment.inspect', { operationId: parent.enrollmentOperationId! })
  await vi.waitFor(async () => { await f.settle(); view = await f.client.call('connection.enrollment.inspect', { operationId: parent.enrollmentOperationId! }); expect(view.account).not.toBeNull() }, { timeout: 8000 })
  expect(view.account).not.toBeNull(); expect(f.creationCount).toBe(0)
  expect([...document.querySelectorAll('.mote-bot-auth-actions .primary-button')].map(node => node.textContent)).toEqual(['Confirm this account'])
  expect(document.querySelector('.mote-bot-setup > [aria-label="Original bot setup results"]')).toBeNull()
  await f.click('Confirm this account'); expect(f.creationCount).toBe(0)
  await f.click('Create this bot')
}

it('creates from the saved public profile through original IPC/Core/Main/default Host and keeps every result separate', async () => {
  await create()
  expect(document.querySelector('.mote-bot-confirmation')?.textContent).toContain('Sign in to Feishu')
  expect(document.body.textContent).not.toContain('DO-NOT-PUBLISH-DISPLAY')
  expect(f.beginCount).toBe(1); expect(f.authenticationCount).toBe(0); expect(f.creationCount).toBe(0)
  const current = document.querySelector('.mote-bot-auth-actions')!
  expect([...current.querySelectorAll('.primary-button')].map(node => node.textContent)).toEqual(['Check sign-in'])
  expect([...current.querySelectorAll('.small-button')].map(node => node.textContent)).toEqual([])
  expect(document.querySelector('.mote-details__issue')).toBeNull()
  const input = original()
  expect(useAppStore.getState().moteBotRequests[input.operationId]?.input).toEqual(input)
  expect(input.source.target).toEqual(f.target())
  expect(input.avatar).toBe('include-saved')
  expect((await f.cli('ls', { target: f.target() })).operations[0].operationId).toBe(input.operationId)
  await confirmAndCreate()
  await text('Original save confirmed'); await text('Profile written. Check and publish it on the platform.')
  const saved = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
  expect(saved.defaultSave?.observedReceipt?.status).toBe('saved')
  expect(saved.profile?.patch.state).toBe('confirmed')
  expect(saved.profile?.online?.profile?.description).toBe('Original online description')
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(1)
  const wire = f.calls.find(r => r.method === 'PATCH')!.data
  expect(JSON.stringify(wire)).toContain('Saved public name'); expect(JSON.stringify(wire)).not.toContain('DO-NOT-PUBLISH')
  expect(f.calls.some(r => r.url?.endsWith('/publish'))).toBe(false)
})

it('names the original advertised platform in its confirmation surface', async () => {
  await f.close(); f = await moteBotUi({ generic: true })
  await create(false); await text('Check the account and enterprise')
  expect(document.querySelector('.mote-bot-request-heading')?.textContent).toContain('Signed profile')
  const current = document.querySelector('.mote-bot-auth-actions')!
  expect([...current.querySelectorAll('.primary-button')].map(node => node.textContent)).toEqual(['Confirm this account'])
  expect([...current.querySelectorAll('.small-button')].map(node => node.textContent)).toEqual([])
  const details = [...document.querySelectorAll<HTMLDetailsElement>('details')].find(node => node.querySelector('summary')?.textContent === 'Original setup details')!
  expect(details.open).toBe(false)
  expect(details.querySelector('[aria-label="Original bot setup results"]')).not.toBeNull()
  expect(details.textContent).toContain('Check saved progress')
  expect(document.querySelector('.mote-details__issue')).toBeNull()
  await f.click('Original setup details')
  await f.click('View original result')
  await text('Saved progress checked.')
  expect(document.querySelector('.mote-details__issue')).toBeNull()
  expect(f.counts.begin).toBe(1); expect(f.counts.authentication).toBe(1); expect(f.counts.create).toBe(0)
})

it.each(['missing', 'unobserved'] as const)('shows a %s saved bot before disclosure and opens recovery without replacing its original reference', async condition => {
  await create(); await confirmAndCreate(); await text('Original save confirmed')
  const before = await f.preferences.read({ kind: 'connection', target: f.target() })
  const writes = f.writes, forward = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, input) => {
    if (method === 'connection.ls' && condition === 'unobserved') throw new Error('Controlled bot-list observation gap')
    const value = await forward(method, input)
    return method === 'connection.ls' ? { ...value, connections: [] } as typeof value : value
  })
  await f.click('Close bot choice'); await f.remount()
  const reason = condition === 'missing' ? 'The saved bot is unavailable here' : 'Controlled bot-list observation gap'
  await text(reason)
  const notice = document.querySelector('.mote-bot-saved-issue')!
  expect(notice.textContent).toContain(reason)
  expect(document.querySelector('.mote-connection-dialog')?.textContent?.split(reason)).toHaveLength(2)
  expect(notice.textContent).toContain('open.feishu.cn')
  expect(notice.textContent).toContain('cli_mote_1')
  expect(notice.closest('details')).toBeNull()
  expect(document.querySelector<HTMLDetailsElement>('.mote-bot-existing')?.open).toBe(false)
  await text('Create another bot for this Mote'); await f.click('Review saved bot')
  expect(document.querySelector<HTMLDetailsElement>('.mote-bot-existing')?.open).toBe(true)
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values).toEqual(before.values)
  expect(f.saves).not.toHaveBeenCalled(); expect(f.writes).toBe(writes); expect(f.beginCount).toBe(1)
})

it('retains original create before a lost Renderer reply, discovers the same parent after rehydrate and never begins again', async () => {
  let lose = true
  f.parentCalls.mockImplementation(async (method, input) => {
    const value = await f.forward(method, input)
    if (method === 'space.mote.connection.create' && lose) { lose = false; throw new Error('Controlled lost Renderer reply') }
    return value
  })
  await f.open(); await text('Saved public name'); await f.click('Create a bot for this Mote');
  await expect(f.parentCalls.mock.results[f.parentCalls.mock.calls.findIndex(([m]) => m === 'space.mote.connection.create')]!.value).rejects.toThrow('Controlled lost Renderer reply'); await text('This setup is not confirmed')
  const input = original(); expect(useAppStore.getState().moteBotRequests[input.operationId]?.input).toEqual(input)
  await f.click('Close bot choice'); await f.remount()
  await f.click('Previous bot operations');
  await act(async () => (document.querySelector('[data-mote-bot-operation="' + input.operationId + '"]') as HTMLElement).click()); await text('Scan to sign in')
  expect(f.beginCount).toBe(1); expect(f.authenticationCount).toBe(0)
  expect(f.parentCalls.mock.calls.filter(([m]) => m === 'space.mote.connection.create')).toHaveLength(1)
})

it('keeps an unresolved raw request discoverable when both the create reply and recovery list are unavailable', async () => {
  let failed = false
  f.parentCalls.mockImplementation(async (method, input) => {
    if (method === 'space.mote.connection.ls' && failed) throw new Error('Controlled list observation gap')
    const value = await f.forward(method, input)
    if (method === 'space.mote.connection.create') { failed = true; throw new Error('Controlled lost Renderer reply') }
    return value
  })
  await f.open(); await text('Saved public name'); await f.click('Create a bot for this Mote')
  await expect(f.parentCalls.mock.results[f.parentCalls.mock.calls.findIndex(([m]) => m === 'space.mote.connection.create')]!.value).rejects.toThrow('Controlled lost Renderer reply');
  await text('This setup is not confirmed'); const input = original()
  await vi.waitFor(async () => expect((await f.client.call('space.mote.connection.inspect', {operationId: input.operationId})).operation, 'The original public owner must record the same operation before testing Renderer reply loss').not.toBeNull())
  await f.click('Close bot choice'); await f.remount()
  await f.click('Previous bot operations'); await f.click('Unconfirmed bot setup · Creation'); await text('Scan to sign in')
  expect(f.beginCount).toBe(1); expect(useAppStore.getState().moteBotRequests[input.operationId]?.input).toEqual(input)
})

it('does not let a late Mote A create result populate Mote B and allows an independent setup while A is waiting', async () => {
  let release!: () => void
  f.parentCalls.mockImplementation(async (method, input) => {
    const value = await f.forward(method, input)
    if (method === 'space.mote.connection.create' && (input as any).source.target.spaceId === f.target().spaceId) await new Promise<void>(resolve => { release = resolve })
    return value
  })
  await f.open(); await text('Saved public name'); await f.click('Create a bot for this Mote')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const a = original().operationId
  await f.render(1); await f.open(1); await text('Saved public name'); await f.click('Create a bot for this Mote'); await text('Scan to sign in')
  const b = (f.parentCalls.mock.calls.filter(([m]) => m === 'space.mote.connection.create').at(-1)![1] as any).operationId
  expect(b).not.toBe(a); expect(f.beginCount).toBe(2)
  await act(async () => release()); await f.settle()
  expect(document.body.textContent).not.toContain(a)
  expect((await f.client.call('space.mote.connection.ls', { target: f.target(1) })).operations.map(x => x.operationId)).toEqual([b])
})

it('synchronizes only the exact selected bot and preserves an unknown patch without another upload or write', async () => {
  await create(); await confirmAndCreate(); await text('Original save confirmed')
  await f.click('Back to bot profile'); await text('Sync Mote profile')
  f.setUnknownPatch(); await f.click('Sync Mote profile'); await text('The profile write is not confirmed')
  const inputs = f.parentCalls.mock.calls.filter(([m]) => m === 'space.mote.connection.sync')
  expect(inputs).toHaveLength(1)
  expect((inputs[0]![1] as any).connection.application.appId).toBe('cli_mote_1')
  const before = f.calls.filter(r => r.method === 'PATCH').length
  await f.click('Check saved progress'); await text('The profile write is not confirmed')
  expect(f.calls.filter(r => r.method === 'PATCH')).toHaveLength(before)
  expect(f.registration.mock.calls).toHaveLength(8)
})

it('keeps a lost default ACK separate from the current file and allows a new association of the same created app', async () => {
  await f.close(); f = await moteBotUi({ loseFileAck: true })
  await create(); await confirmAndCreate(); await text('Original save not confirmed')
  const id = original().operationId
  const parent = (await f.client.call('space.mote.connection.inspect', { operationId: id })).operation!
  expect(parent.defaultSave?.observedReceipt?.status).toBe('unconfirmed')
  await f.click('Check current choice'); expect(f.beginCount).toBe(1)
  const input = { kind: 'connection' as const, target: f.target() }
  const current = await f.preferences.read(input)
  expect(current.values?.connection).toEqual(parent.connection)
  expect(moteConnectionBaseline(current)).not.toBeNull()
  expect(document.body.textContent).toContain('Original save not confirmed')
})

it('changes the default through the original choice writer and reads the same exact file with the compiled CLI', async () => {
  await create(); await confirmAndCreate(); await text('Original save confirmed')
  await f.click('Back to bot profile'); await f.click('Change bot')
  await f.click('Mote chat bot')
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes('No default bot'))!
  expect(option).toBeDefined(); await act(async () => option.click())
  await f.click('Use this bot')
  await vi.waitFor(() => expect(document.querySelector('.mote-connection-dialog')).toBeNull())
  expect(f.saves).toHaveBeenCalledTimes(1)
  expect((await f.preferenceCli()).values).toEqual({ connection: null })
  expect(f.beginCount).toBe(1)
})

it('keeps another original operation readable while an older query response is waiting', async () => {
  await create(); const a = original().operationId
  await f.click('Create another bot'); await f.click('Start a separate setup'); await f.click('Create a bot for this Mote'); await text('Scan to sign in')
  const b = (f.parentCalls.mock.calls.filter(([m]) => m === 'space.mote.connection.create').at(-1)![1] as any).operationId
  let release!: () => void
  f.parentCalls.mockImplementation(async (method, input) => {
    const result = await f.forward(method, input)
    if (method === 'space.mote.connection.inspect' && (input as any).operationId === a) {
      await new Promise<void>(resolve => { release = resolve }); throw new Error('Controlled old A query error')
    }
    return result
  })
  await f.click('Previous bot operations')
  await act(async () => (document.querySelector('[data-mote-bot-operation="' + a + '"]') as HTMLElement).click())
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await act(async () => (document.querySelector('[data-mote-bot-operation="' + b + '"]') as HTMLElement).click())
  await text('Saved progress checked.')
  await act(async () => release()); await f.settle()
  expect(document.body.textContent).not.toContain('Controlled old A query error')
  expect(f.parentCalls.mock.calls.some(([method,input]) => method === 'space.mote.connection.inspect' && (input as any).operationId === b)).toBe(true)
  expect(f.beginCount).toBe(2)
})

it('does not dispatch the same creation form twice when its original response is delayed', async () => {
  let release!: () => void
  f.parentCalls.mockImplementation(async (method, input) => {
    const result = await f.forward(method, input)
    if (method === 'space.mote.connection.create') await new Promise<void>(resolve => { release = resolve })
    return result
  })
  await f.open(); await text('Saved public name')
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Create a bot for this Mote')!
  await act(async () => { node.click(); node.click() })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(f.parentCalls.mock.calls.filter(([method]) => method === 'space.mote.connection.create')).toHaveLength(1)
  expect(f.beginCount).toBe(1)
  await act(async () => release()); await text('Scan to sign in')
})

it('keeps the original Mote Profile caller and source preview while leaving the discussion and original input drafts intact', async () => {
  const before = useAppStore.getState()
  await f.renderMotePanel()
  await vi.waitFor(() => expect(document.querySelector('[data-mote-details] .mote-connection__row')).not.toBeNull())
  await act(async () => (document.querySelector('.mote-connection__row') as HTMLElement).click())
  await text('Saved public summary.')
  expect(document.querySelector('.mote-bot-profile img')).not.toBeNull()
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(f.beginCount).toBe(0)
  await f.click('Manage bots')
  expect(f.navigation.openMoteConnector).toHaveBeenCalledWith({ target: f.target(), topicId: f.scopes[0]!.topic.id, moteName: f.scopes[0]!.topic.title })
})

it('retains a known not-dispatched request when local persistence is unavailable and explicitly continues that same request after recovery', async () => {
  await f.open(); await text('Saved public name')
  const store = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Controlled local persistence failure') })
  await f.click('Create a bot for this Mote'); await text('No request was sent')
  const raw = Object.values(useAppStore.getState().moteBotRequests)[0]!
  expect(raw.phase).toBe('not-dispatched'); expect(f.beginCount).toBe(0)
  store.mockRestore()
  await f.click('Continue this request'); await text('Scan to sign in')
  expect(f.beginCount).toBe(1)
  expect(original().operationId).toBe(raw.input.operationId)
})
