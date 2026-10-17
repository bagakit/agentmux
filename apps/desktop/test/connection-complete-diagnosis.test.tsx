// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { enrollmentInitialWeb } from '../../../packages/connectors/test/fixtures/connection-enrollment-initial'
import { registerLoadedIdentityIpc } from '../src/main/client-observation'
import { senderTrust, assertSenderTrusted } from '../src/main/ipc-sender-trust'
import { api } from '../src/renderer/src/lib/api'
import { ConnectionRequestTrace } from '../src/renderer/src/components/settings/ConnectionRequestTrace'
import { createClientUiRoot } from './helpers/client-ui-render'
import { diagnosisText } from './helpers/connection-diagnosis-text'
import { confirmAndCreateMote } from './fixtures/mote-connection-owner'

let f: Awaited<ReturnType<typeof moteBotUi>>
const loadedPackage = { schema: 'agentmux.package-identity.v1', sourceCommit: 'loaded-original-source', sourceTree: 'loaded-original-tree', appVersion: '1', platform: 'darwin', arch: 'arm64' } as const
let renderer = { kind: 'bundled' as const, id: 'a'.repeat(64), identity: { shell: 'loaded-shell', ctxmux: 'loaded-native-pair' } }
beforeEach(async () => {
  f = await moteBotUi()
  const handlers = new Map<string, (event: any) => unknown>()
  registerLoadedIdentityIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, f.sender)),
    package: { ...loadedPackage, ...{ rawPrivate: 'private-package-extra' } }, renderer: () => ({ ...renderer, ...{ rawPrivate: 'private-renderer-extra' } }) })
  vi.spyOn(api.ui, 'readLoadedIdentity').mockImplementation(async () => handlers.get('ui:readLoadedIdentity')!({ sender: f.sender }) as any)
  expect(() => handlers.get('ui:readLoadedIdentity')!({ sender: {} })).toThrow('Untrusted loaded application identity sender')
})
afterEach(async () => { await f?.close() })
async function create() {
  const web = enrollmentInitialWeb({ name: 'Saved public name', description: 'Saved public summary.' })
  f.registration.mockImplementation(web.fetch)
  await f.open(); await f.click('Create a bot for this Mote')
  await vi.waitFor(() => expect(document.querySelector('[data-mote-enrollment-action="confirm-account"]')).not.toBeNull(), { timeout: 10_000 })
  await f.click('Confirm this account')
  await f.click('Create, configure & publish')
  await vi.waitFor(() => expect(document.querySelector('[data-initial-setup-stage]')?.getAttribute('data-state')).toBe('complete'), { timeout: 10_000 })
  await Promise.all(f.parentCalls.mock.results.filter(result => result.type === 'return').map(result => result.value))
  const input = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as { operationId: string }
  const parent = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
  return { web, parent }
}
it('copies the collapsed creation task with actual loaded identity and both exact original journals once', async () => {
  const { web, parent } = await create(), before = [...web.requests]
  expect([...document.querySelectorAll('button')].filter(button => button.textContent === 'Copy diagnosis')).toHaveLength(1)
  expect([...document.querySelectorAll<HTMLDetailsElement>('[data-request-trace]')].every(d => !d.open)).toBe(true)
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.click('Copy diagnosis')
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const text = clipboard.mock.calls[0]![0], report = diagnosisText(text), enrollmentId = parent.enrollmentOperationId!, setupId = parent.enrollment!.initialSetup!.operationId
  expect(report.complete).toBe(true)
  expect(report.observations['mote:' + parent.operationId], text).toMatchObject({ action: parent.action, issue: parent.issue })
  expect(report.observations['enrollment:' + enrollmentId]).toMatchObject({ authorization: 'authorized', creation: { upload: 'confirmed', create: 'confirmed' }, configuration: 'configured' })
  expect(report.observations['setup:' + setupId]).toMatchObject({ initialSetup: { stage: 'publication-status', state: 'complete', versionId: 'initial-version' } })
  expect(report.traces.map(t => [t.kind, t.operationId, t.status])).toEqual([['enrollment', enrollmentId, 'complete'], ['setup', setupId, 'complete']])
  for (const trace of report.traces) {
    const result = await f.client.call(trace.kind === 'setup' ? 'connection.setup.inspect' : 'connection.enrollment.inspect', { operationId: trace.operationId, requestTrace: { limit: 100 } })
    expect(result.requestTrace!.next).toBeNull()
    expect(trace.entries).toEqual(result.requestTrace!.entries)
  }
  expect(text).toContain('loaded-original-source'); expect(text).toContain('loaded-native-pair')
  expect(text).not.toMatch(/Saved public|initial-private|original-creator|original-tenant|private-package|private-renderer|pngDataUrl|csrf|cookie|https?:\/\/|SOUL|notes|draft/iu)
  expect(web.requests).toEqual(before)
  expect(f.parentCalls.mock.calls.filter(([method]) => method.endsWith('.advance'))).not.toHaveLength(0)
  expect(document.body.textContent).toContain('Complete sanitized diagnosis copied.')
}, 30_000)

it('keeps the complete enrollment section when the linked setup view and trace are unavailable', async () => {
  const { web, parent } = await create(), before = [...web.requests], setupId = parent.enrollment!.initialSetup!.operationId
  const forward = f.connectionCalls.getMockImplementation()!
  f.connectionCalls.mockImplementation(async (method, input) => {
    if (method === 'connection.setup.inspect' && input.operationId === setupId) throw new Error('private setup exception body')
    return forward(method, input)
  })
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.click('Copy diagnosis'); await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const text = clipboard.mock.calls[0]![0], report = diagnosisText(text)
  expect(report.complete).toBe(false)
  expect(report.observations['setup:' + setupId].status).toBe('unavailable')
  expect(report.traces.find(t => t.kind === 'enrollment')!.status).toBe('complete')
  expect(report.traces.find(t => t.kind === 'enrollment')!.entries.length).toBeGreaterThan(1)
  expect(report.traces.find(t => t.kind === 'setup')).toMatchObject({ status: 'unavailable', entries: [] })
  expect(text).not.toContain('private setup exception')
  expect(document.body.textContent).toContain('report is incomplete')
  expect(web.requests).toEqual(before)
}, 30_000)

it('copies an unadmitted original ID and dispatch risk without inventing a cause or requiring a visible trace page', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(<ConnectionRequestTrace source={null} diagnosisTarget={{ kind: 'mote', operationId: 'not-admitted-original', sourceTarget: f.target(), action: 'create', phase: 'may-have-dispatched' }} />))
    const before = f.registration.mock.calls.length, clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Copy diagnosis')!
    expect(button.disabled).toBe(false)
    await act(async () => button.click()); await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
    const report = diagnosisText(clipboard.mock.calls[0]![0])
    expect(report.complete).toBe(false)
    expect(report.observations['mote:not-admitted-original']).toEqual({ status: 'not-recorded', action: 'create', clientPhase: 'may-have-dispatched', cause: 'not-recorded' })
    expect(report.traces).toEqual([]); expect(f.registration.mock.calls).toHaveLength(before)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('keeps unavailable loaded metadata explicit without hiding the original diagnosis', async () => {
  vi.mocked(api.ui.readLoadedIdentity).mockRejectedValue(new Error('private identity exception'))
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(<ConnectionRequestTrace source={null} diagnosisTarget={{ kind: 'mote', operationId: 'original-identity-gap', sourceTarget: f.target() }} />))
    const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click()); await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
    expect(clipboard.mock.calls[0]![0]).toContain('package: unavailable')
    expect(clipboard.mock.calls[0]![0]).toContain('original-identity-gap — not-recorded')
    expect(clipboard.mock.calls[0]![0]).not.toContain('private identity exception')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('copies the actual failed creation observation and captured native code without inventing trace history', async () => {
  f.registration.mockImplementation(async () => Response.json({ code: 17, message: 'private platform denial body' }))
  await f.open(); await f.click('Create a bot for this Mote')
  await vi.waitFor(() => expect(document.body.textContent).toContain('Sign-in result not confirmed'))
  const input = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as { operationId: string }
  const parent = (await f.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
  const before = f.registration.mock.calls.length, clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.click('Copy diagnosis'); await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const text = clipboard.mock.calls[0]![0], report = diagnosisText(text), observed = report.observations['enrollment:' + parent.enrollmentOperationId]
  expect(observed.diagnostic).toMatchObject({ stage: 'authentication', nativeCode: 17, httpStatus: 200 })
  expect(text).toContain('Attention: enrollment: begin-unconfirmed')
  expect(report.traces[0]!.entries.every(row => row.diagnostic === undefined)).toBe(true)
  expect(text).not.toContain('private platform denial'); expect(f.registration.mock.calls).toHaveLength(before)
  expect(f.creationCount).toBe(0)
}, 30_000)

it('uses the shared total report for a profile request which was not admitted by Main', async () => {
  const input = await f.input('unadmitted-profile-source')
  await f.client.call('space.mote.connection.create', input); await confirmAndCreateMote(f, input.operationId)
  await f.open()
  const forward = f.parentCalls.getMockImplementation()!
  f.parentCalls.mockImplementation(async (method, value) => {
    if (method === 'space.mote.connection.sync') throw new Error('private transport exception details')
    return forward(method, value)
  })
  await f.click('Sync Mote profile')
  await vi.waitFor(() => expect(document.body.textContent).toContain('setup is not confirmed'))
  const request = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.sync')![1] as { operationId: string }
  const before = f.registration.mock.calls.length, clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await f.click('Copy diagnosis'); await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
  const text = clipboard.mock.calls[0]![0], report = diagnosisText(text)
  expect(report.observations['mote:' + request.operationId]).toMatchObject({ status: 'not-recorded', action: 'sync', clientPhase: 'may-have-dispatched', cause: 'not-recorded' })
  expect(report.traces).toEqual([]); expect(text).not.toContain('private transport exception')
  expect(f.registration.mock.calls).toHaveLength(before)
}, 30_000)

it('refuses a parent from another selected Mote without reading its children', async () => {
  const { parent } = await create(), container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(<ConnectionRequestTrace source={null} diagnosisTarget={{ kind: 'mote', operationId: parent.operationId, sourceTarget: f.target(1) }} />))
    const before = f.connectionCalls.mock.calls.length, clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click()); await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
    const report = diagnosisText(clipboard.mock.calls[0]![0])
    expect(report.observations['mote:' + parent.operationId]).toEqual({ status: 'conflicting-target' })
    expect(report.traces).toEqual([]); expect(f.connectionCalls.mock.calls).toHaveLength(before)
    expect(clipboard.mock.calls[0]![0]).not.toContain(parent.connection!.application.appId)
  } finally { await act(async () => root.unmount()); container.remove() }
}, 30_000)
