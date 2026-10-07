// @vitest-environment happy-dom
import { act } from 'react'
import type { AgentMuxRpcParams } from '@agentmux/core'
import { resolve } from 'node:path'
import { DesktopConnectorSecrets } from '../src/main/connector-secrets.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { enrollmentFixture } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'
import { ExternalConnectionsSettings } from '../src/renderer/src/components/settings/ExternalConnectionsSettings'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
let fixture: Awaited<ReturnType<typeof enrollmentFixture>>
let originalCall: typeof api.connections.call
async function open(options?: Parameters<typeof enrollmentFixture>[0]) {
  fixture = await enrollmentFixture(options)
  originalCall = async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => fixture.sdk.call(method, params as AgentMuxRpcParams<M>) as Promise<ConnectionResultMap[M]>
  vi.spyOn(api.connections, 'call').mockImplementation(originalCall)
  vi.spyOn(api.connections, 'storeCredential').mockImplementation(input => fixture.services.secrets.store(input))
  vi.spyOn(api.connections, 'inspectCredential').mockImplementation(operationId => fixture.services.secrets.inspect(operationId))
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux')) })
afterEach(async () => { await dom.render(null); await fixture?.close(); vi.unstubAllEnvs() })
async function mount() {
  await dom.render(<ExternalConnectionsSettings active />)
  await ready('[data-enrollment-create]')
}
async function ready(selector: string) {
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector(selector), selector).not.toBeNull() })
}
async function click(selector: string) {
  await vi.waitFor(async () => {
    await act(async () => {})
    const target = dom.container.querySelector<HTMLElement>(selector)
    expect(target, selector).not.toBeNull()
    expect(target!.closest('details:not([open])'), 'open the real disclosure before using a hidden control').toBeNull()
    expect(target!.hasAttribute('disabled')).toBe(false)
  })
  await dom.click(selector)
}
async function inspectOriginal() {
  const control = dom.container.querySelector('[data-enrollment-inspect]')
  if (control?.closest('details:not([open])')) await dom.click('.connector-diagnostics > summary')
  await click('[data-enrollment-inspect]')
}
async function select(operationId: string) {
  if (dom.container.querySelector('[data-enrollment-operation]')) await click('.connector-enrollment > .connector-back')
  const history = dom.container.querySelector<HTMLDetailsElement>('.connector-enrollment__history')!
  if (!history.open) await dom.click('.connector-enrollment__history > summary')
  await click(`[data-enrollment-select="${operationId}"]`)
}
async function fill(label: string, value: string) {
  const field = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
  return field
}

it('reads earlier durable setups by their real cursor without selecting or recreating the first pending entry', async () => {
  await open()
  for (let index = 0; index < 26; index++) await fixture.sdk.call('connection.enrollment.begin', { ...fixture.input, operationId: `setup-${index}`, connectionId: `connection-${index}`, label: `Bot ${index}` })
  await mount()
  expect(dom.container.querySelector('[data-enrollment-operation]')).toBeNull()
  expect(dom.container.querySelector('[data-enrollment-select="setup-0"]')).toBeNull()
  expect(fixture.begin).toHaveBeenCalledTimes(26)
  await click('[data-enrollment-more]')
  await ready('[data-enrollment-select="setup-0"]')
  await select('setup-0')
  expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe('setup-0')
  expect(dom.container.querySelector('.connector-enrollment__identity')?.textContent).toContain('Bot 0')
  await inspectOriginal()
  expect(fixture.begin).toHaveBeenCalledTimes(26); expect(fixture.poll).not.toHaveBeenCalled()
  const result = await fixture.cli(['enrollment', 'inspect', '--operation-id', 'setup-0'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout).result.operation).toMatchObject({ operationId: 'setup-0', connectionId: 'connection-0' })
})

it('explicitly recovers an unknown encrypted handoff locally before a separate user action polls the original challenge', async () => {
  await open()
  const store = DesktopConnectorSecrets.prototype.store
  let loseSnapshot = true
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function(this: DesktopConnectorSecrets, input) {
    const result = await store.call(this, input)
    if (loseSnapshot && input.secret.includes('privateState')) { loseSnapshot = false; throw new Error('Controlled encrypted snapshot receipt loss') }
    return result
  })
  await mount(); await click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect((await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]?.authorization).toBe('unknown'); expect(dom.container.querySelector('[data-enrollment-advance]')).not.toBeNull() })
  const original = (await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]!
  await inspectOriginal()
  expect(fixture.poll).not.toHaveBeenCalled()
  await click('[data-enrollment-advance]')
  await ready('[data-enrollment-code] svg')
  expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.poll).not.toHaveBeenCalled()
  await click('[data-enrollment-advance]')
  await ready('[data-enrollment-saved]')
  const final = (await fixture.sdk.call('connection.enrollment.inspect', { operationId: original.operationId })).operation!
  expect(final).toMatchObject({ operationId: original.operationId, connectionId: original.connectionId, configuration: 'configured' })
  expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.poll).toHaveBeenCalledTimes(1)
})

it('a delayed original list cannot regress the same setup after its real configure receipt is confirmed', async () => {
  await open(); const original = await fixture.sdk.call('connection.enrollment.begin', fixture.input)
  await mount(); await select(original.operationId)
  let release!: () => void, delayed = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await originalCall(method, params)
    if (method === 'connection.enrollment.ls' && !delayed) { delayed = true; await gate }
    return result
  })
  try {
    await dom.render(<ExternalConnectionsSettings active={false} />)
    await dom.render(<ExternalConnectionsSettings active />)
    await vi.waitFor(() => expect(delayed).toBe(true))
    await click('[data-enrollment-advance]'); await ready('[data-enrollment-saved]')
    const saved = (await fixture.sdk.call('connection.enrollment.inspect', { operationId: original.operationId })).operation!
    await act(async () => { release(); await gate })
    expect(dom.container.querySelector('[data-enrollment-saved]')).not.toBeNull()
    expect(dom.container.querySelector('[data-enrollment-code]')).toBeNull()
    expect(dom.container.querySelector('.connector-diagnostics')?.textContent).toContain(String(saved.revision))
    expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.poll).toHaveBeenCalledTimes(1)
  } finally { release() }
})

it('an earlier lookup failure does not become current after selecting A, B and the same exact A again', async () => {
  await open()
  const a = await fixture.sdk.call('connection.enrollment.begin', fixture.input)
  const b = await fixture.sdk.call('connection.enrollment.begin', { ...fixture.input, operationId: 'other-setup', connectionId: 'other-connection', label: 'Other bot' })
  await mount(); await select(a.operationId)
  let release!: () => void, read = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await originalCall(method, params)
    if (method === 'connection.enrollment.inspect' && (params as { operationId: string }).operationId === a.operationId) { read = true; await gate; throw new Error('Only the earlier setup lookup failed') }
    return result
  })
  try {
    await inspectOriginal(); await vi.waitFor(() => expect(read).toBe(true))
    await select(b.operationId)
    await select(a.operationId)
    await act(async () => { release(); await gate })
    expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(a.operationId)
    expect(dom.container.querySelector('.connector-enrollment__identity')?.textContent).toContain('Original bot')
    expect(dom.container.textContent).not.toContain('Only the earlier setup lookup failed')
  } finally { release() }
})

it('a late original begin result preserves the manual draft, composing input node, focus and selection', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await open({ begin: async () => { await gate; return { kind: 'pending', verificationUrl: 'https://verify.example.invalid/confirm', expiresInMs: null, pollIntervalMs: 0, privateState: 'private-original' } } })
  await mount(); await click('[data-enrollment-create]')
  await vi.waitFor(() => expect(fixture.begin).toHaveBeenCalledTimes(1))
  await click('.connector-enrollment > .connector-back'); await click('[data-enrollment-existing]')
  const input = await fill('Connection app ID', '原有机器人-草稿')
  await fill('Connection app secret', 'private-manual-draft')
  await act(async () => { input.focus(); input.setSelectionRange(2, 5); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '组字' })) })
  try {
    await act(async () => { release(); await gate })
    await vi.waitFor(async () => expect((await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]?.authorization).toBe('pending'))
    expect(dom.container.querySelector('[aria-label="Connection app ID"]')).toBe(input)
    expect(document.activeElement).toBe(input); expect(input.value).toBe('原有机器人-草稿'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5])
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')?.value).toBe('private-manual-draft')
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组字' })))
    await click('.connector-back'); await click('[data-enrollment-resume]'); await ready('[data-enrollment-code] svg'); await click('.connector-enrollment > .connector-back'); await click('[data-enrollment-existing]')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app ID"]')?.value).toBe('原有机器人-草稿')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')?.value).toBe('private-manual-draft')
    expect(await fixture.services.connections.list()).toEqual({ connections: [] })
  } finally { release() }
})

it('unavailable secure creation keeps original setups and the existing-bot path without pretending a platform picker is ready', async () => {
  await open(); const original = await fixture.sdk.call('connection.enrollment.begin', fixture.input)
  vi.spyOn(fixture.encryption, 'isEncryptionAvailable').mockReturnValue(false)
  await dom.render(<ExternalConnectionsSettings active />)
  await ready('[data-enrollment-existing]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Scan setup is not available here') })
  expect(dom.container.querySelector('[data-enrollment-create]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Bot creation platform"]')).toBeNull()
  await select(original.operationId)
  await inspectOriginal()
  expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.poll).not.toHaveBeenCalled()
  await click('.connector-enrollment > .connector-back'); await click('[data-enrollment-existing]')
  expect(dom.container.querySelector('[aria-label="Connection app ID"]')).not.toBeNull()
})

it.each(['denied', 'expired'] as const)('shows original %s without another QR, implicit cancellation or repeated creation', async kind => {
  await open({ poll: async () => ({ kind }) })
  await mount(); await click('[data-enrollment-create]'); await ready('[data-enrollment-code] svg')
  await click('[data-enrollment-advance]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelector('.connector-diagnostics')?.textContent).toContain(kind) })
  expect(dom.container.querySelector('[data-enrollment-code]')).toBeNull()
  expect(dom.container.querySelector('[data-enrollment-create]')).toBeNull()
  expect(dom.container.querySelector('[data-enrollment-advance]')).toBeNull()
  await inspectOriginal()
  expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.poll).toHaveBeenCalledTimes(1)
})


it('a known not-started setup explicitly resumes its exact original begin after secure storage is repaired', async () => {
  await open(); await mount()
  vi.spyOn(fixture.encryption, 'isEncryptionAvailable').mockReturnValue(false)
  await click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect((await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]?.authorization).toBe('not-started'); expect(dom.container.querySelector('[data-enrollment-advance]')?.hasAttribute('disabled')).toBe(false) })
  const original = (await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]!
  expect(fixture.begin).not.toHaveBeenCalled()
  vi.mocked(fixture.encryption.isEncryptionAvailable).mockReturnValue(true)
  await click('[data-enrollment-advance]'); await ready('[data-enrollment-code] svg')
  const inputs = vi.mocked(api.connections.call).mock.calls.filter(call => call[0] === 'connection.enrollment.begin').map(call => call[1])
  expect(inputs).toHaveLength(2); expect(inputs[1]).toEqual(inputs[0])
  expect((await fixture.sdk.call('connection.enrollment.inspect', { operationId: original.operationId })).operation).toMatchObject({ operationId: original.operationId, connectionId: original.connectionId, authorization: 'pending' })
  expect(fixture.begin).toHaveBeenCalledTimes(1)
  await click('[data-enrollment-advance]'); await ready('[data-enrollment-saved]')
  expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.poll).toHaveBeenCalledTimes(1)
})


it('opens only the original public confirmation URL and keeps its QR and recovery after a failed external handoff', async () => {
  await open(); await mount(); await click('[data-enrollment-create]'); await ready('[data-enrollment-code] svg')
  const original = (await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]!
  const external = vi.spyOn(api.ui, 'openExternal').mockRejectedValue(new Error('Controlled confirmation handoff failed'))
  await click('[data-enrollment-open]')
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('Controlled confirmation handoff failed') })
  expect(external).toHaveBeenCalledExactlyOnceWith(original.challenge!.verificationUrl)
  expect(dom.container.querySelector('[data-enrollment-code] svg')).not.toBeNull()
  expect(dom.container.querySelector('[data-enrollment-advance]')?.hasAttribute('disabled')).toBe(false)
  expect(dom.container.querySelector('[data-enrollment-inspect]')?.hasAttribute('disabled')).toBe(false)
  expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.poll).not.toHaveBeenCalled()
})


it('keeps a submitted original intent reachable after its real begin reply is lost and the user returns to all setups', async () => {
  await open(); await mount()
  let operationId = '', release!: () => void, delayList = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const result = await originalCall(method, params)
    if (method === 'connection.enrollment.begin') { operationId = (params as { operationId: string }).operationId; throw new Error('Controlled Renderer reply loss after original admission') }
    if (method === 'connection.enrollment.ls' && delayList) await gate
    return result
  })
  try {
    await click('[data-enrollment-create]')
    await vi.waitFor(async () => { await act(async () => {}); expect(operationId).not.toBe(''); expect(dom.container.querySelector('[data-enrollment-inspect]')?.hasAttribute('disabled')).toBe(false) })
    expect((await fixture.sdk.call('connection.enrollment.inspect', { operationId })).operation?.authorization).toBe('pending')
    delayList = true
    await click('.connector-enrollment > .connector-back')
    expect(dom.container.querySelector('[data-enrollment-create]')).toBeNull()
    expect(dom.container.querySelector('[data-enrollment-resume]')).not.toBeNull()
    expect(dom.container.querySelector('[aria-label="New bot name"]')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Bot creation platform"]')).toBeNull()
    expect(dom.container.querySelector('.connector-enrollment__identity')?.textContent).toContain('Signed challenge bot')
    await select(operationId)
    expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(operationId)
    await inspectOriginal(); await ready('[data-enrollment-code] svg')
    expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.poll).not.toHaveBeenCalled()
    await act(async () => { release(); await gate })
    expect((await fixture.sdk.call('connection.enrollment.ls', {})).operations.map(item => item.operationId)).toEqual([operationId])
  } finally { release() }
})
