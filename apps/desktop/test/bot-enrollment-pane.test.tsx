// @vitest-environment happy-dom
import { act } from 'react'
import type { AgentMuxRpcParams } from '@agentmux/core'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import iconUrl from '../resources/icon-512.png'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { enrollmentFixture } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'
import { ExternalConnectionsSettings } from '../src/renderer/src/components/settings/ExternalConnectionsSettings'
import { api } from '../src/renderer/src/lib/api'
import type { ConnectionHostingTarget } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { connectionSettingsPort } from '../src/renderer/src/lib/connection-settings-port'
import { composerDOM } from './helpers/composer-dom-fixture'
import { copyConnectorIdentity } from './helpers/connector-identity-copy'

const dom = composerDOM(), hostingTarget: ConnectionHostingTarget = { hostId: 'local', runtimeId: 'original-enrollment-runtime' }, connections = connectionSettingsPort(hostingTarget)
let fixture: Awaited<ReturnType<typeof enrollmentFixture>>
let originalCall: typeof api.connections.call
async function open(options?: Parameters<typeof enrollmentFixture>[0]) {
  fixture = await enrollmentFixture(options)
  originalCall = async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M], target?: ConnectionHostingTarget): Promise<ConnectionResultMap[M]> => { expect(target).toEqual(hostingTarget); return fixture.sdk.call(method, params as AgentMuxRpcParams<M>) as Promise<ConnectionResultMap[M]> }
  vi.spyOn(api.connections, 'call').mockImplementation(originalCall)
  vi.spyOn(api.connections, 'storeCredential').mockImplementation(input => fixture.services.secrets.store(input))
  vi.spyOn(api.connections, 'inspectCredential').mockImplementation(operationId => fixture.services.secrets.inspect(operationId))
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const config = useAppStore.getState().config!
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  window.localStorage.clear(); await useAppStore.persist.rehydrate()
  const stop = await useAppStore.getState().initialize(); stop()
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const image = await readFile(join(import.meta.dirname, '../resources/icon-512.png'))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { expect(url).toBe(iconUrl); return new Response(new Uint8Array(image)) }))
})
afterEach(async () => { await dom.render(null); await fixture?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
async function mount() {
  await dom.render(<ExternalConnectionsSettings connections={connections} hostingTarget={hostingTarget} active />)
  await ready('[data-enrollment-new]'); await click('[data-enrollment-new]')
  await ready('[data-enrollment-create]')
  expect(dom.container.querySelector('[data-bot-setup-guide]')?.getAttribute('data-bot-setup-guide')).toBe('prepare')
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
  await act(async () => {
    const button = dom.container.querySelector<HTMLButtonElement>('[data-enrollment-inspect], [data-enrollment-recover]')!
    expect(button).toBeTruthy()
    const details = button.closest<HTMLDetailsElement>('details:not([open])')
    if (details) details.querySelector<HTMLElement>('summary')!.click()
    expect(button.closest('details:not([open])'), 'Open the current receipt disclosure before reading it').toBeNull()
    button.click()
  })
}
async function select(operationId: string) {
  if (dom.container.querySelector('[data-enrollment-operation]')) await click('.connector-enrollment > .connector-back')
  const history = dom.container.querySelector<HTMLDetailsElement>('.connector-enrollment__history')!
  if (!history.open) await dom.click('.connector-enrollment__history > summary')
  await click(`[data-enrollment-history="${operationId}"]`)
}
async function fill(label: string, value: string) {
  const field = dom.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
  return field
}

async function finishCreation(intent: 'initial-publication-unsupported' | 'configured-only') {
  if (dom.container.querySelector('[data-enrollment-action="continue-authentication"]'))
    await click('[data-enrollment-action="continue-authentication"]')
  await ready('[data-enrollment-action="confirm-account"]')
  expect(dom.container.querySelector('[data-bot-setup-guide]')?.getAttribute('data-bot-setup-guide')).toBe('account')
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const account = dom.container.querySelector<HTMLElement>('.connector-account-summary')!
  expect(account).not.toBeNull()
  expect(account.querySelector('img')).toBeNull()
  await copyConnectorIdentity(account, 'Copy Account ID', 'original-user')
  await copyConnectorIdentity(account, 'Copy Tenant ID', 'original-tenant')
  await click('[data-enrollment-action="confirm-account"]')
  await ready('[data-enrollment-action="create"]')
  expect(dom.container.querySelector('[data-bot-setup-guide]')?.getAttribute('data-bot-setup-guide')).toBe('create')
  expect(fixture.create).not.toHaveBeenCalled()
  await click('[data-enrollment-action="create"]')
  await ready('[data-enrollment-saved]')
  const original = (await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]!
  expect(original.configuration).toBe('configured')
  if (intent === 'initial-publication-unsupported') {
    expect(original.initialPublication).toEqual({ version: '1.0.0', notes: 'Enable AMUX conversations.' })
    expect(original.initialSetup?.progress?.state).toBe('attention')
    expect(dom.container.querySelector('[data-bot-setup-guide]')?.getAttribute('data-bot-setup-guide')).toBe('attention')
  } else {
    expect(original.initialPublication).toBeUndefined()
    expect(dom.container.querySelector('[data-bot-setup-guide]')?.getAttribute('data-bot-setup-guide')).toBe('ready')
  }
}

it('reads earlier durable setups by their real cursor without selecting or recreating the first pending entry', async () => {
  await open()
  for (let index = 0; index < 26; index++) await fixture.sdk.call('connection.enrollment.begin', { ...fixture.input, operationId: `setup-${index}`, connectionId: `connection-${index}`, label: `Bot ${index}` })
  await mount()
  expect(dom.container.querySelector('[data-enrollment-operation]')).toBeNull()
  expect(dom.container.querySelector('[data-enrollment-history="setup-0"]')).toBeNull()
  expect(fixture.begin).toHaveBeenCalledTimes(26)
  await dom.click('.connector-enrollment__history > summary')
  await click('.connector-enrollment__history .small-button')
  await ready('[data-enrollment-history="setup-0"]')
  await select('setup-0')
  expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe('setup-0')
  expect(dom.container.querySelector('.connector-enrollment__identity')?.textContent).toContain('Bot 0')
  await inspectOriginal()
  expect(fixture.begin).toHaveBeenCalledTimes(26); expect(fixture.authentication).not.toHaveBeenCalled()
  const result = await fixture.cli(['enrollment', 'inspect', '--operation-id', 'setup-0'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout).result.operation).toMatchObject({ operationId: 'setup-0', connectionId: 'connection-0' })
})

it('explicitly recovers an unknown private handoff locally before a separate user action polls the original challenge', async () => {
  await open()
  const store = ConnectionSecrets.prototype.store
  let loseSnapshot = true
  vi.spyOn(ConnectionSecrets.prototype, 'store').mockImplementation(async function(this: ConnectionSecrets, input) {
    const result = await store.call(this, input)
    if (loseSnapshot && input.secret.includes('privateState')) { loseSnapshot = false; throw new Error('Controlled private snapshot receipt loss') }
    return result
  })
  await mount(); await click('[data-enrollment-create]')
  await vi.waitFor(async () => { await act(async () => {}); expect((await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]?.authentication?.stage).toBe('unknown'); expect(dom.container.querySelector('[data-enrollment-advance]')).not.toBeNull() })
  const original = (await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]!
  expect(original.diagnostic).toEqual({ stage: 'secure-storage', code: 'challenge-unconfirmed' })
  expect(dom.container.querySelector('[data-enrollment-diagnosis]')?.textContent).toBe('Secure confirmation progress could not be checked or saved here.')
  expect(dom.container.querySelector('[data-bot-setup-guide]')?.getAttribute('data-bot-setup-guide')).toBe('attention')
  expect(dom.container.querySelectorAll('[data-bot-enrollment] .primary-button')).toHaveLength(1)
  await inspectOriginal()
  expect(fixture.authentication).not.toHaveBeenCalled()
  await click('[data-enrollment-advance]')
  await ready('[data-enrollment-code] svg')
  expect(dom.container.querySelector('[data-bot-setup-guide]')?.getAttribute('data-bot-setup-guide')).toBe('scan')
  expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.authentication).not.toHaveBeenCalled()
  await finishCreation('initial-publication-unsupported')
  const final = (await fixture.sdk.call('connection.enrollment.inspect', { operationId: original!.operationId })).operation!
  expect(final).toMatchObject({ operationId: original!.operationId, connectionId: original.connectionId, configuration: 'configured' })
  expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.authentication).toHaveBeenCalledTimes(1)
})

it('a delayed original list cannot regress the same setup after its real configure receipt is confirmed', async () => {
  await open(); const { operation: original } = await fixture.sdk.call('connection.enrollment.begin', fixture.input)
  await mount(); await select(original!.operationId)
  let release!: () => void, delayed = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M], target?: ConnectionHostingTarget): Promise<ConnectionResultMap[M]> => {
    const result = await originalCall(method, params, target)
    if (method === 'connection.enrollment.ls' && !delayed) { delayed = true; await gate }
    return result
  })
  try {
    await dom.render(<ExternalConnectionsSettings connections={connections} hostingTarget={hostingTarget} active={false} />)
    await dom.render(<ExternalConnectionsSettings connections={connections} hostingTarget={hostingTarget} active />)
    await vi.waitFor(() => expect(delayed).toBe(true))
    await inspectOriginal()
    await ready('[data-enrollment-action="continue-authentication"]')
    await finishCreation('configured-only')
    const saved = (await fixture.sdk.call('connection.enrollment.inspect', { operationId: original!.operationId })).operation!
    await act(async () => { release(); await gate })
    expect(dom.container.querySelector('[data-enrollment-saved]')).not.toBeNull()
    expect(dom.container.querySelector('[data-enrollment-code]')).toBeNull()
    expect(dom.container.querySelector('.connector-enrollment > .connector-diagnostics')?.textContent).toContain(String(saved.revision))
    expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.authentication).toHaveBeenCalledTimes(1)
  } finally { release() }
})

it('an earlier lookup failure does not become current after selecting A, B and the same exact A again', async () => {
  await open()
  const { operation: a } = await fixture.sdk.call('connection.enrollment.begin', fixture.input)
  const { operation: b } = await fixture.sdk.call('connection.enrollment.begin', { ...fixture.input, operationId: 'other-setup', connectionId: 'other-connection', label: 'Other bot' })
  await mount(); await select(a!.operationId)
  let release!: () => void, read = false, holdFirst = true
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M], target?: ConnectionHostingTarget): Promise<ConnectionResultMap[M]> => {
    const result = await originalCall(method, params, target)
    if (method === 'connection.enrollment.inspect' && (params as { operationId: string }).operationId === a!.operationId && holdFirst) { holdFirst = false; read = true; await gate; throw new Error('Only the earlier setup lookup failed') }
    return result
  })
  try {
    await select(a!.operationId); await vi.waitFor(() => expect(read).toBe(true))
    await select(b!.operationId)
    await select(a!.operationId)
    await act(async () => { release(); await gate })
    expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(a!.operationId)
    expect(dom.container.querySelector('.connector-enrollment__identity')?.textContent).toContain('Original bot')
    expect(dom.container.textContent).not.toContain('Only the earlier setup lookup failed')
  } finally { release() }
})

it('a late original begin result preserves the manual draft, composing input node, focus and selection', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await open()
  const begin = fixture.begin.getMockImplementation()!
  fixture.begin.mockImplementation(async input => { await gate; return begin(input) })
  await mount(); await click('[data-enrollment-create]')
  await vi.waitFor(() => expect(fixture.begin).toHaveBeenCalledTimes(1))
  await click('.connector-enrollment > .connector-back'); await click('[data-enrollment-existing]')
  const input = await fill('Connection app ID', '原有机器人-草稿')
  await fill('Connection app secret', 'private-manual-draft')
  await act(async () => { input.focus(); input.setSelectionRange(2, 5); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '组字' })) })
  try {
    await act(async () => { release(); await gate })
    await vi.waitFor(async () => expect((await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]?.authentication?.stage).toBe('waiting'))
    expect(dom.container.querySelector('[aria-label="Connection app ID"]')).toBe(input)
    expect(document.activeElement).toBe(input); expect(input.value).toBe('原有机器人-草稿'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5])
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')?.value).toBe('private-manual-draft')
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组字' })))
    await click('.connector-back'); await click('[data-enrollment-new]'); await select((await fixture.sdk.call('connection.enrollment.ls', {})).operations[0]!.operationId); await inspectOriginal(); await ready('[data-enrollment-code] svg'); await click('.connector-enrollment > .connector-back'); await click('[data-enrollment-existing]')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app ID"]')?.value).toBe('原有机器人-草稿')
    expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Connection app secret"]')?.value).toBe('private-manual-draft')
    expect(await fixture.services.connections.list()).toEqual({ connections: [] })
  } finally { release() }
})

it('a successful list refresh cannot clear an unconfirmed application save or replay its original write', async () => {
  await open(); await mount(); await click('[data-enrollment-existing]')
  await fill('Connection app ID', 'cli_existing_bot')
  await fill('Connection app secret', 'private-existing-bot-credential')
  await dom.click('.connector-setup__fields .connector-optional > summary')
  await click('[aria-label="Connection enabled"]')
  let loseReply = true
  vi.mocked(api.connections.call).mockImplementation(async (method, input, target) => {
    const result = await originalCall(method, input, target)
    if (method === 'connection.configure' && loseReply) { loseReply = false; throw new Error('Controlled original save reply gap') }
    return result
  })
  await click('[data-connection-save]')
  await vi.waitFor(() => expect(dom.container.querySelector('.connector-issue')?.textContent).toContain('Save result not confirmed'))
  const writes = () => vi.mocked(api.connections.call).mock.calls.filter(([method]) => method === 'connection.configure')
  const original = structuredClone(writes()[0]![1])
  await dom.render(<ExternalConnectionsSettings connections={connections} hostingTarget={hostingTarget} active={false} />)
  await dom.render(<ExternalConnectionsSettings connections={connections} hostingTarget={hostingTarget} active />)
  await vi.waitFor(() => expect(vi.mocked(api.connections.call).mock.calls.filter(([method]) => method === 'connection.ls').length).toBeGreaterThan(1))
  await act(async () => {
    const reader = vi.mocked(api.connections.call)
    await Promise.all(reader.mock.calls.flatMap(([method], index) => method === 'connection.ls' ? [reader.mock.results[index]!.value] : []))
  })
  expect(dom.container.querySelector('.connector-issue')?.textContent).toContain('Save result not confirmed')
  expect(writes()).toHaveLength(1)
  expect(writes()[0]![1]).toEqual(original)
  await click('[data-connection-save]')
  await vi.waitFor(() => expect(dom.container.querySelector('.connector-connection-state')?.textContent).toContain('Application paused'))
  expect(writes()).toHaveLength(1)
  expect(fixture.begin).not.toHaveBeenCalled()
})

it('keeps metadata and the existing-bot path browsable while the original secure action remains locked', async () => {
  await open(); const { operation: original } = await fixture.sdk.call('connection.enrollment.begin', fixture.input)
  const secure = vi.spyOn(ConnectionSecrets.prototype, 'assertAvailable').mockRejectedValue(new Error('Original private storage unavailable'))
  await mount()
  await ready('[data-enrollment-existing]')
  expect(secure).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-enrollment-create]')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Bot creation platform"]')).toBeNull()
  await select(original!.operationId)
  await inspectOriginal()
  expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.authentication).not.toHaveBeenCalled()
  await click('.connector-enrollment > .connector-back'); await click('[data-enrollment-existing]')
  expect(dom.container.querySelector('[aria-label="Connection app ID"]')).not.toBeNull()
})

it('keeps an expired original sign-in and offers explicit renewal without creating a bot', async () => {
  await open({ advance: async input => ({ kind: 'authentication', stage: 'expired', challenge: null, account: null, privateState: input.privateState }) })
  const { operation } = await fixture.sdk.call('connection.enrollment.begin', fixture.input)
  await mount(); await select(operation!.operationId)
  await click('[data-enrollment-action="continue-authentication"]')
  await ready('[data-enrollment-action="renew-authentication"]')
  expect(dom.container.querySelector('[data-enrollment-code]')).toBeNull()
  expect(dom.container.querySelector('[data-bot-enrollment] h3')?.textContent).toBe('This sign-in code expired')
  expect(fixture.begin).toHaveBeenCalledTimes(1)
  expect(fixture.authentication).toHaveBeenCalledTimes(1)
  expect(fixture.create).not.toHaveBeenCalled()
  await inspectOriginal()
  expect(fixture.begin).toHaveBeenCalledTimes(1)
  expect(fixture.authentication).toHaveBeenCalledTimes(1)
})

it('keeps a submitted original intent reachable after its real begin reply is lost and the user returns to all setups', async () => {
  await open(); await mount()
  let operationId = '', release!: () => void, delayList = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.connections.call).mockImplementation(async <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M], target?: ConnectionHostingTarget): Promise<ConnectionResultMap[M]> => {
    const result = await originalCall(method, params, target)
    if (method === 'connection.enrollment.begin') { operationId = (params as { operationId: string }).operationId; throw new Error('Controlled Renderer reply loss after original admission') }
    if (method === 'connection.enrollment.ls' && delayList) await gate
    return result
  })
  try {
    await click('[data-enrollment-create]')
    await vi.waitFor(async () => { await act(async () => {}); expect(operationId).not.toBe(''); expect(dom.container.querySelector('[data-enrollment-inspect]')?.hasAttribute('disabled')).toBe(false) })
    expect((await fixture.sdk.call('connection.enrollment.inspect', { operationId })).operation?.authentication?.stage).toBe('waiting')
    delayList = true
    await click('.connector-enrollment > .connector-back')
    expect(dom.container.querySelector('[data-enrollment-create]')).toBeNull()
    expect(dom.container.querySelector('[data-enrollment-resume]')).not.toBeNull()
    expect(dom.container.querySelector('[aria-label="New bot name"]')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Bot creation platform"]')).toBeNull()
    expect(dom.container.querySelector('.connector-enrollment__resume')?.textContent).toMatch(/AMUX-[0-9A-Z]+/)
    await select(operationId)
    expect(dom.container.querySelector('[data-enrollment-operation]')?.getAttribute('data-enrollment-operation')).toBe(operationId)
    await ready('[data-enrollment-code] svg'); await inspectOriginal()
    expect(fixture.begin).toHaveBeenCalledTimes(1); expect(fixture.authentication).not.toHaveBeenCalled()
    await act(async () => { release(); await gate })
    expect((await fixture.sdk.call('connection.enrollment.ls', {})).operations.map(item => item.operationId)).toEqual([operationId])
  } finally { release() }
})


it('keeps a generated general identity name stable across catalog reads and freezes it at sign-in', async () => {
  await open(); await mount()
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="New bot name"]')!
  const name = input.value
  expect(name).toMatch(/^AMUX-[0-9A-Z]+$/)
  await dom.render(<ExternalConnectionsSettings connections={connections} hostingTarget={hostingTarget} active />)
  expect(dom.container.querySelector('[aria-label="New bot name"]')).toBe(input)
  expect(input.value).toBe(name)
  await click('[data-enrollment-create]')
  await ready('[data-enrollment-operation]')
  await vi.waitFor(() => expect(fixture.begin.mock.calls[0]?.[0]).toMatchObject({ label: name }))
  const id = fixture.begin.mock.calls[0]![0].operationId
  expect((await fixture.sdk.call('connection.enrollment.inspect', { operationId: id })).operation).toMatchObject({ label: name, preset: { name } })
})
