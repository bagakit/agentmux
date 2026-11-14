import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { CONVERSATION_CONFIRMED_SEND_RECEIPTS, resolveConversationConfirmedSendReceipt, resolveConversationShowSendReceipts } from '@agentmux/client-ui/conversation-send-receipts'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { ConfigStore } from '../src/main/config-store.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { themeObservation } from '../../host/src/theme-observation.js'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../src/renderer/src/store'
import { MobileApp } from '../../mobile/src/MobileApp'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../../mobile/src/recovery/device-workface'

// Add a read-only witness inside the original Provider; preserve every original child and adapter.
vi.mock('@agentmux/client-ui/platform', async importOriginal => {
  const actual = await importOriginal<typeof import('@agentmux/client-ui/platform')>()
  function Witness() {
    const platform = actual.useClientUiPlatform()
    return <output data-send-receipt-context>{JSON.stringify([platform.conversationShowSendReceipts, platform.conversationConfirmedSendReceipt])}</output>
  }
  return { ...actual, ClientUiProvider: ({ children, platform }: { children: ReactNode; platform: import('@agentmux/client-ui/platform').ClientUiPlatform }) =>
    <actual.ClientUiProvider platform={platform}><Witness />{children}</actual.ClientUiProvider> }
})

const showKey = 'appearance.conversationShowSendReceipts', confirmedKey = 'appearance.conversationConfirmedSendReceipt'
const cleanups: Array<() => void | Promise<void>> = []
const initialStore = useAppStore.getState()
let root: Root, container: HTMLDivElement
const fact = (value: object) => { if (process.env.AGENTMUX_RECEIPTS_FACTS) appendFileSync(process.env.AGENTMUX_RECEIPTS_FACTS, JSON.stringify(value) + '\n') }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const media = Object.assign(new EventTarget(), { matches: true })
  vi.stubGlobal('matchMedia', vi.fn(() => media)); window.matchMedia = vi.fn(() => media as MediaQueryList)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  useAppStore.setState(initialStore, true); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function until(ready: () => boolean) {
  for (let i = 0; i < 100 && !ready(); i++) await act(async () => { await new Promise(done => setTimeout(done, 10)) })
  expect(ready(), container.textContent ?? '').toBe(true)
}
const context = () => container.querySelector('[data-send-receipt-context]')?.textContent
async function actualHost() {
  const fixture = await configOwnerFixture(), directory = await mkdtemp(join(tmpdir(), 'srp-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const operations: string[] = []
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'c.sock'), coreClients: () => [], appearance: themeObservation(fixture.owner),
    execute: request => {
      operations.push(request.operation)
      if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw Error('Only private scalar settings operations are configured')
      return executeSettingsControl(request, fixture.owner)
    } })
  cleanups.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const subscribeRpc = vi.fn(rpc.subscribe.bind(rpc))
  const client = { subscribeRpc, agentSessions: () => [], onEvent: () => () => {} } as unknown as AgentMuxHostedClient
  return { fixture, directory, server, rpc, client, subscribeRpc, operations }
}

it('discovers and validates both public scalars, persists actual source CLI edits and keeps the other preferences intact', async () => {
  const { fixture, directory, server, rpc, operations } = await actualHost()
  const before = await fixture.bytes(), found = await rpc.call('settings.inspect', { target: 'appearance' })
  expect(found.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: showKey, value: true, default: true, kind: 'boolean' }),
    expect.objectContaining({ key: confirmedKey, value: 'compact', default: 'compact', enum: [...CONVERSATION_CONFIRMED_SEND_RECEIPTS] })
  ]))
  await rpc.call('settings.set', { key: showKey, value: 'true' }); await rpc.call('settings.set', { key: confirmedKey, value: 'compact' })
  expect(await fixture.bytes()).toBe(before)
  const loader = pathToFileURL(resolve(process.cwd(), 'packages/core/test/fixtures/hook-delivery/source-loader.mjs'))
  const cli = (key: string, value: string) => runSourceObjectCli(['--endpoint', 'unix:' + server.path, 'settings', 'set', key, value],
    objectCliEnvironment(directory, { AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED: process.env.AGENTMUX_RECEIPTS_CLI_LOADS }), '', 15000, loader)
  for (const [key, value] of [[showKey, 'false'], [confirmedKey, 'keep']] as const) {
    const result = await cli(key, value); expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result.entry.value).toBe(key === showKey ? false : value)
  }
  const saved = await new ConfigStore(fixture.store.filePath).get()
  expect(saved.appearance).toMatchObject({ conversationShowSendReceipts: false, conversationConfirmedSendReceipt: 'keep' })
  const original = JSON.parse(before)
  expect({ ...saved.appearance, conversationShowSendReceipts: undefined, conversationConfirmedSendReceipt: undefined }).toEqual({ ...original.appearance, conversationShowSendReceipts: undefined, conversationConfirmedSendReceipt: undefined })
  const validBytes = await fixture.bytes()
  await expect(rpc.call('settings.set', { key: showKey, value: 'yes' })).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  await expect(rpc.call('settings.set', { key: confirmedKey, value: 'future-choice' })).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  expect(await fixture.bytes()).toBe(validBytes)
  expect(new Set(operations)).toEqual(new Set(['settings.get', 'settings.set']))
  fact({ case: 'public-scalar-cli', discovered: [showKey, confirmedKey], cliExitCodes: [0, 0], saved: [saved.appearance.conversationShowSendReceipts, saved.appearance.conversationConfirmedSendReceipt], operations })
})

it('retains unsupported authored JSON while reading defaults and merging only the original field with exact conflicts', async () => {
  const { fixture } = await actualHost(), unknownShow = { future: ['visibility'] }, unknownConfirmed = ['future-mode']
  await fixture.owner.update(config => ({ ...config, appearance: { ...config.appearance, conversationShowSendReceipts: unknownShow, conversationConfirmedSendReceipt: unknownConfirmed } }))
  const before = structuredClone(fixture.owner.current)
  await fixture.owner.update(config => ({ ...config, copyPathsAsAbsolute: true }))
  await fixture.owner.edit(before, { ...before, appearance: { ...before.appearance, conversationConfirmedSendReceipt: 'hide' } })
  expect(fixture.owner.current.appearance.conversationShowSendReceipts).toEqual(unknownShow)
  await expect(fixture.owner.edit(before, { ...before, appearance: { ...before.appearance, conversationConfirmedSendReceipt: 'keep' } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: confirmedKey })
  await fixture.owner.update(config => ({ ...config, appearance: { ...config.appearance, conversationConfirmedSendReceipt: unknownConfirmed } }))
  const reopened = await new ConfigStore(fixture.store.filePath).get()
  expect(reopened.appearance.conversationShowSendReceipts).toEqual(unknownShow); expect(reopened.appearance.conversationConfirmedSendReceipt).toEqual(unknownConfirmed)
  expect(resolveConversationShowSendReceipts(reopened.appearance.conversationShowSendReceipts)).toBe(true)
  expect(resolveConversationConfirmedSendReceipt(reopened.appearance.conversationConfirmedSendReceipt)).toBe('compact')
  const reader = await themeObservation(fixture.owner).subscribe(() => {}, () => {}, new AbortController().signal)
  expect(reader.initial.values).toMatchObject({ conversationShowSendReceipts: unknownShow, conversationConfirmedSendReceipt: unknownConfirmed })
  expect(reader.initial.issues.map(issue => issue.id)).toEqual(expect.arrayContaining(['conversation-send-receipts', 'conversation-confirmed-send-receipt']))
  reader.dispose(); expect(reopened.copyPathsAsAbsolute).toBe(true)
  fact({ case: 'unknown-and-conflict', persistedOriginalJSON: true, resolved: [true, 'compact'], unrelatedFieldPreserved: true })
})

it('the actual Desktop provider consumes committed ConfigOwner choices and preserves its original child', async () => {
  const { fixture } = await actualHost()
  useAppStore.setState({ config: fixture.owner.current })
  const release = fixture.owner.subscribe(saved => { useAppStore.setState({ config: saved }) })
  cleanups.push(release)
  await act(async () => root.render(<DesktopClientUiProvider><textarea aria-label="Original Desktop draft" defaultValue="Unsent Desktop text" /></DesktopClientUiProvider>))
  await until(() => context() === '[true,"compact"]')
  const draft = container.querySelector('textarea')!
  for (const mode of CONVERSATION_CONFIRMED_SEND_RECEIPTS) {
    await act(async () => { await fixture.owner.update(config => ({ ...config, appearance: { ...config.appearance, conversationShowSendReceipts: false, conversationConfirmedSendReceipt: mode } })) })
    await until(() => context() === JSON.stringify([false, mode])); expect(container.querySelector('textarea')).toBe(draft)
  }
  await act(async () => { await fixture.owner.update(config => ({ ...config, appearance: { ...config.appearance, conversationShowSendReceipts: 'unsupported', conversationConfirmedSendReceipt: {} } })) })
  await until(() => context() === '[true,"compact"]')
  fact({ case: 'actual-desktop-provider', choices: [...CONVERSATION_CONFIRMED_SEND_RECEIPTS], originalDraftSameNode: true, unsupportedDefaults: [true, 'compact'] })
})

it('actual MobileApp and its original provider consume preference-only Host watch edits and retain the last confirmed values while disconnected', async () => {
  const { fixture, client, subscribeRpc } = await actualHost(), workface = getDeviceWorkface(), original = workface.snapshot().record
  cleanups.push(async () => { await workface.replaceBackup(original) })
  await workface.replaceBackup(emptyDeviceWorkface()); await workface.confirmHost({ origin: location.origin, hostId: 'local' })
  const identity = { name: 'Private receipt preferences', project: 'Read-only welcome', mote: { spaceId: 'receipt-preferences-mote', name: 'Private receipt preferences',
    contentReference: { hostId: 'local', workspaceId: 'receipt-workspace', workspacePath: directoryPath(), zoneId: 'receipt-zone' } } }
  await workface.updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' }, {
    primary: 'mote', showSession: true, showGoalWork: false, recentMoteSpaceId: identity.mote.spaceId, identity, profile: null,
    moteView: { spaceId: identity.mote.spaceId, section: 'discussion', detail: false, directAgent: false } })
  const platform = createBrowserPlatform({ overlayContainer: () => container })
  const draw = (connected: boolean) => act(async () => root.render(<MobileApp client={client} connection={{ state: connected ? 'connected' : 'disconnected', message: 'Private appearance-only Host' }} platform={platform} restoreWorkface />))
  await draw(true); await until(() => context() === '[true,"compact"]')
  const editor = container.querySelector('[contenteditable=true]')!
  expect(editor).not.toBeNull()
  await act(async () => { await fixture.owner.update(config => ({ ...config, appearance: { ...config.appearance, conversationShowSendReceipts: false } })) })
  await until(() => context() === '[false,"compact"]')
  await act(async () => { await fixture.owner.update(config => ({ ...config, appearance: { ...config.appearance, conversationConfirmedSendReceipt: 'hide' } })) })
  await until(() => context() === '[false,"hide"]')
  expect(container.querySelector('[contenteditable=true]')).toBe(editor); expect(subscribeRpc).toHaveBeenCalledTimes(1)
  await draw(false)
  await act(async () => { await fixture.owner.update(config => ({ ...config, appearance: { ...config.appearance, conversationShowSendReceipts: true, conversationConfirmedSendReceipt: 'keep' } })) })
  expect(context()).toBe('[false,"hide"]')
  await draw(true); await until(() => context() === '[true,"keep"]'); expect(subscribeRpc).toHaveBeenCalledTimes(2)
  await act(async () => { await fixture.owner.update(config => ({ ...config, appearance: { ...config.appearance,
    conversationShowSendReceipts: { future: false }, conversationConfirmedSendReceipt: ['future-mode'] } })) })
  await until(() => context() === '[true,"compact"]')
  expect((await fixture.disk()).appearance).toMatchObject({ conversationShowSendReceipts: { future: false }, conversationConfirmedSendReceipt: ['future-mode'] })
  expect(container.querySelector('[contenteditable=true]')).toBe(editor)
  fact({ case: 'actual-mobile-provider-watch', initial: [true, 'compact'], booleanOnlyEdit: [false, 'compact'], enumOnlyEdit: [false, 'hide'], disconnectedRetained: [false, 'hide'], reconnected: [true, 'keep'], unsupportedResolved: [true, 'compact'], unsupportedJSONPreserved: true, subscriptions: 2, originalEditorSameNode: true, runtimeControlCalls: [] })
})
const directoryPath = () => join(tmpdir(), 'private-receipt-workspace')
