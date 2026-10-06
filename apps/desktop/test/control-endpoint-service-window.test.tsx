import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxError, AgentMuxMemoryAgentSessionStore, type AgentMuxClientEvent } from '@agentmux/core'
import { connectHostedAgentMux as defaultConnectHostedAgentMux, type AgentMuxHostedRpcPort } from '@agentmux/core/hosted'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import type { AgentMuxClient } from '../../../packages/core/src/client'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import type { WebContents } from 'electron'
import type { DesktopRuntimeClient } from '../src/main/desktop-host'
import { RuntimeController } from '../src/main/runtime-controller'
import type { RuntimeEndpointWarning, RuntimeEvent } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
const connectHostedAgentMux: typeof defaultConnectHostedAgentMux = process.env.AGENTMUX_TEST_HOSTED_CLIENT_ENTRY
  ? (await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_HOSTED_CLIENT_ENTRY)).connectHostedAgentMux : defaultConnectHostedAgentMux

const step = 'Publishing control endpoint'
const diagnostic = { code: 'CONTROL_ENDPOINT_PUBLICATION_UNAVAILABLE', message: 'Original control endpoint cannot be published.' }
const dom = composerDOM(), sent: RuntimeEvent[] = []
let controller: RuntimeController, listener: ((event: AgentMuxClientEvent) => void) | undefined
let detach: (() => void) | undefined
const write = vi.fn(async () => {})
const client = {
  connect: async () => {}, connectRuntime: async () => {}, dispose: async () => {},
  onEvent: (callback: (event: AgentMuxClientEvent) => void) => { listener = callback; return () => { listener = undefined } },
  writeAgent: write,
  providers: { catalog: () => { throw new AgentMuxError('Original catalog observation failed.', 'CATALOG_OBSERVATION_FAILED') } },
  sessionHistorySources: async () => { throw new AgentMuxError('Original History observation failed.', 'HISTORY_OBSERVATION_FAILED') }
}
function publication(state: 'available' | 'unavailable', observedAt = 1): AgentMuxClientEvent {
  // The producer and codec are qualified by the Core owner's actual socket fixture.
  const evidence = { source: 'agentmux' as const, observedAt }
  return state === 'unavailable' ? { type: 'control-endpoint-state', state, diagnostic, evidence }
    : { type: 'control-endpoint-state', state, evidence }
}
const warning = (hostId: string, warningStep: string, scope?: 'observation'): RuntimeEndpointWarning => ({
  hostId, step: warningStep, ...(scope ? { scope } : {}), availability: 'connected',
  code: 'ORIGINAL_OTHER_FAILURE', message: 'Original unrelated failure', recovery: 'Original unrelated recovery'
})
beforeEach(async () => {
  sent.length = 0; write.mockClear()
  controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => client as unknown as DesktopRuntimeClient)
  controller.commit(await controller.prepare(composerConfig))
  const webContents = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false,
    send: (_channel: string, event: RuntimeEvent) => { sent.push(event); useAppStore.getState().applyEvent(event) } })
  detach = controller.attach(webContents as unknown as WebContents)
  useAppStore.setState({ loading: false, sessions: [{ ...composerSession(), status: { state: 'working', source: 'native-hook', observedAt: Date.now() } }], runtimeEndpointWarnings: [],
    runtimeOwnershipWarnings: [], environmentWarning: undefined, displacedAgentSessionIds: [],
    noticeReadReceipts: {}, workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null,
    desktopNavigationNotice: null, errorNoticeContext: null })
})
afterEach(async () => { detach?.(); await controller.dispose() })
const mount = () => dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn(), openHost: vi.fn() }}>
  <GlobalSystemNotices />
</SettingsNavigation.Provider>)

it('delivers the Core publication fact through Main to a visible service window while exact Agent input remains available', async () => {
  const original = useAppStore.getState(), input = document.createElement('textarea')
  input.value = 'Original unsent input'; document.body.append(input); input.focus(); input.setSelectionRange(3, 10)
  try {
    await mount()
    await act(async () => listener!(publication('unavailable')))
    expect(controller.endpointWarningSnapshot(), 'Main must retain the original publication observation').toContainEqual(expect.objectContaining({
      hostId: 'local', step, scope: 'observation', availability: 'connected', ...diagnostic
    }))
    expect(sent.at(-1)).toMatchObject({ endpointObservation: { step, warning: { ...diagnostic, scope: 'observation' } } })
    expect(dom.container.querySelector('.notification-item[data-notice-id]')).not.toBeNull()
    expect(dom.container.textContent).toContain(`This Mac: ${step}`)
    expect(dom.container.textContent).toContain('automatically')
    await controller.write(composerSession().control, 'Original exact input', 'user')
    expect(write).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'agent-1', expectedRun: { runId: 'run-agent-1' }, data: 'Original exact input', source: 'user' })
    const current = useAppStore.getState()
    expect(current.sessions).toEqual(original.sessions)
    expect(current.tabs).toBe(original.tabs); expect(current.layouts).toBe(original.layouts)
    expect(current.agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect([input.value, input.selectionStart, input.selectionEnd, document.activeElement === input]).toEqual(['Original unsent input', 3, 10, true])
  } finally { input.remove() }
})

it('clears only the publication observation in Main and Renderer and admits a visible recurrence', async () => {
  await expect(controller.providerCatalog()).rejects.toThrow('Original catalog observation failed.')
  await expect(controller.sessionHistorySources()).rejects.toThrow('Original History observation failed.')
  const unrelated = [...controller.endpointWarningSnapshot(), warning('local', 'Observing Runtime'), warning('other', step, 'observation')]
  useAppStore.setState({ runtimeEndpointWarnings: unrelated })
  await mount()
  await act(async () => listener!(publication('unavailable')))
  expect(useAppStore.getState().runtimeEndpointWarnings).toHaveLength(unrelated.length + 1)
  await act(async () => listener!(publication('available', 2)))
  expect(sent.at(-1)).toMatchObject({ endpointObservation: { step, warning: null } })
  expect(sent.at(-1)?.endpointWarning).toBeUndefined()
  expect(controller.endpointWarningSnapshot()).toEqual(unrelated.slice(0, 2))
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual(unrelated)
  expect(dom.container.textContent).not.toContain(`This Mac: ${step}`)
  expect(dom.container.querySelectorAll('.notification-item[data-notice-id]')).toHaveLength(unrelated.length)
  await act(async () => listener!(publication('unavailable', 3)))
  expect(dom.container.querySelectorAll('.notification-item[data-notice-id]')).toHaveLength(unrelated.length + 1)
})

it('retains the current unavailable publication through actual Hosted client late Main commit and clears only that fact', async () => {
  const semantic = {
    ...client, runtimeIdentity: () => ({ hostId: 'local', instanceId: 'original-daemon',
      buildIdentity: 'private-fixture', protocolVersion: 1, processId: 123, ownership: 'owned' as const }),
    catalog: () => [], agentSessions: () => [], readAgentSessions: async () => [], metadata: { pendingIds: () => [] }, agentMessageQueuePath: () => _hygiene_fixturePath("private-fixture/messages.ndjson")
  }
  const service = new AgentMuxHostedRuntimeService(semantic as unknown as AgentMuxClient, _hygiene_fixturePath("private-fixture/sessions.json"),
    () => hostedTestOwner(semantic))
  service.publishControlEndpointState({ state: 'unavailable', diagnostic })
  const port = {
    call: async (method: string, params: unknown) => JSON.parse(JSON.stringify(await service.call(method, JSON.parse(JSON.stringify(params))))),
    subscribe: async (method: string, params: unknown, handlers: {
      onInitial(value: unknown): void; onEvent(value: unknown): void; signal?: AbortSignal
    }) => {
      const stream = await service.subscribe(method, JSON.parse(JSON.stringify(params)),
        event => handlers.onEvent(JSON.parse(JSON.stringify(event))), handlers.signal ? { signal: handlers.signal } : {})
      handlers.onInitial(JSON.parse(JSON.stringify(stream.initial))); await stream.start?.()
      return { dispose: async () => { await stream.dispose() } }
    }
  } as unknown as AgentMuxHostedRpcPort
  const hosted = await connectHostedAgentMux({ rpc: port })
  try {
    const cached: AgentMuxClientEvent[] = []
    const release = hosted.onEvent(event => { cached.push(event) })
    await vi.waitFor(() => expect(cached).toContainEqual(expect.objectContaining({ type: 'control-endpoint-state', state: 'unavailable', diagnostic })))
    release()
    // The real SDK has cached unavailable before Main registers its guarded callback.
    await act(async () => {
      detach?.(); await controller.dispose()
      controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => hosted)
      const webContents = Object.assign(new EventEmitter(), { id: 72, isDestroyed: () => false,
        send: (_channel: string, event: RuntimeEvent) => { sent.push(event); useAppStore.getState().applyEvent(event) } })
      detach = controller.attach(webContents as unknown as WebContents)
      controller.commit(await controller.prepare(composerConfig))
    })
    await mount()
    await vi.waitFor(() => expect(controller.endpointWarningSnapshot(), 'late Main commit must retain current unavailable publication').toContainEqual(
      expect.objectContaining({ step, scope: 'observation', availability: 'connected', ...diagnostic })))
    expect(sent.filter(event => event.event.type === 'control-endpoint-state')).toHaveLength(1)
    expect(sent.filter(event => event.event.type === 'connection-state')).toHaveLength(0)
    expect(dom.container.textContent).toContain(`This Mac: ${step}`)
    const metadata = warning('local', 'Reading Provider catalog', 'observation')
    await act(async () => useAppStore.setState(state => ({ runtimeEndpointWarnings: [...state.runtimeEndpointWarnings!, metadata] })))
    await act(async () => service.publishControlEndpointState({ state: 'available' }))
    await vi.waitFor(() => expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([metadata]))
    expect(dom.container.textContent).not.toContain(`This Mac: ${step}`)
    expect(useAppStore.getState().sessions[0]?.control).toEqual(composerSession().control)
  } finally { await hosted.dispose(); await service.dispose() }
})
