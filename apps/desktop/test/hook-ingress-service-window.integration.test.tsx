// @vitest-environment happy-dom
import { writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import type { AgentMuxHostedRpcPort, AgentMuxHostedStreamInitial, AgentMuxHostedStreamMethod } from '../../../packages/core/src/hosted-client-contract.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { hookClientFixture, hookSession, hookRun } from '../../../packages/core/test/helpers/hook-ingress-fixture.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { hookIngressServiceOutcome, classifyServiceNotice, serviceNoticeToRender } from '../src/renderer/src/lib/service-window-notice.js'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices.js'
import { composerSubmitMode } from '../src/renderer/src/lib/composer-submit-mode.js'
import { TerminalServiceNotices } from '../src/renderer/src/components/TerminalServiceNotices.js'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture.js'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
vi.mock('../src/main/host-factory.js', () => ({ createExecutionHost: (config: { id: string; kind: string }) => ({
  id: config.id, kind: config.kind, dispose: async () => {}
}) }))
const dom = composerDOM()
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

it('carries a retained Core failure through Hosted bootstrap, Main snapshot, Renderer events and the existing visible exact-Run refresh', async () => {
  const original = { ...hookSession('failed'), hookBindingId: 'invalid' }, healthy = hookSession('healthy')
  const f = await hookClientFixture([original, healthy])
  await f.inner.tryRestoreHookIngress([hookRun(original), hookRun(healthy)])
  const service = new AgentMuxHostedRuntimeService(f.client, null, () => hostedTestOwner(f.client))
  const rpc = {
    call: async (method: string, params: unknown, context?: { signal?: AbortSignal }) =>
      JSON.parse(JSON.stringify(await service.call(method, JSON.parse(JSON.stringify(params)), context))),
    subscribe: async (method: string, params: unknown, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      const stream = await service.subscribe(method, JSON.parse(JSON.stringify(params)), event => handlers.onEvent(event),
        handlers.signal ? { signal: handlers.signal } : {})
      handlers.onInitial(stream.initial as AgentMuxHostedStreamInitial<AgentMuxHostedStreamMethod>); await stream.start?.()
      return { dispose: async () => { await stream.dispose() } }
    }
  } as AgentMuxHostedRpcPort
  const hosted = await connectHostedAgentMux({ rpc }), controller = new RuntimeController(f.store, async () => hosted)
  let detach = () => {}
  cleanups.push(async () => { detach(); await controller.dispose(); await service.dispose(); await f.client.dispose() })
  controller.commit(await controller.prepare(composerConfig))
  const snapshotRead = vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => await controller.snapshot(composerConfig))
  const snapshot = await controller.snapshot(composerConfig)
  expect(snapshot.sessions).toHaveLength(2)
  const failed = snapshot.sessions.find(value => value.id === original.agentSessionId)!
  expect(failed.kind === 'agent' && failed.hookIngressObservation).toMatchObject({ phase: 'binding', code: 'INVALID_HOOK_BINDING', run: original.run })
  let tab = createWorkbenchTab('hook-original-tab', { regionId: 'hook-original-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: failed.id }, 'Original investigation')
  tab = addWorkbenchRegion(tab, 'hook-original-region', 'right', { regionId: 'hook-neighbor-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: healthy.agentSessionId })
  const tabs = { [tab.id]: tab }, layouts = { workspace: createWorkspaceLayout('hook-original-group', [tab.id]) }
  useAppStore.setState({ activeWorkspaceId: 'workspace', mainSurface: 'board', sessions: snapshot.sessions, noticeReadReceipts: {}, agentComposerDrafts: { [failed.id]: 'Original unsent draft' },
    tabs, layouts })
  const webContents = Object.assign(new EventEmitter(), { id: 185, isDestroyed: () => false,
    send: (_channel: string, event: RuntimeEvent) => { useAppStore.getState().applyEvent(event) } })
  detach = controller.attach(webContents as unknown as WebContents)
  let refresh: Promise<SessionSnapshot> | undefined
  function Notice() {
    const current = useAppStore(state => state.sessions.find(value => value.id === failed.id)!)
    return <TerminalServiceNotices scope={`terminal:local:${current.id}:${current.control.run.runId}`}
      reveal={null} replayGeometry={null} viewportSync={null} continuation={null}
      hookIngress={serviceNoticeToRender(classifyServiceNotice(hookIngressServiceOutcome(current)))}
      onRefreshObservation={() => { refresh = controller.refresh(current.control, composerConfig) }} />
  }
  await dom.render(<Notice />)
  expect(dom.container.textContent).toContain('Native Hook observation')
  expect(dom.container.textContent).toContain('original Run binding')
  expect(dom.container.textContent).toContain('terminal input and output remain separate capabilities')
  expect(sessionServiceNotices(failed).map(value => value.id)).toContain('hook-ingress')
  expect(composerSubmitMode(failed)).toMatchObject({ canType: true, canSubmit: true })
  const restored: RuntimeEvent = { type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: 10 } } }
  await act(async () => useAppStore.getState().applyEvent(restored))
  expect(useAppStore.getState().sessions.find(value => value.id === failed.id)).toMatchObject({ hookIngressObservation: { code: 'INVALID_HOOK_BINDING' } })
  await vi.waitFor(() => expect(snapshotRead).toHaveBeenCalled())
  expect(dom.container.textContent).toContain('original Run binding')
  const nativeStatus = f.inner.kernel.status
  f.inner.kernel.status = async () => { throw Object.assign(new Error('Private native Run observation is temporarily unavailable'), { code: 'PRIVATE_STATUS_UNAVAILABLE' }) }
  await act(async () => { await expect(controller.refresh(failed.control, composerConfig)).rejects.toThrow('Private native Run observation is temporarily unavailable') })
  await vi.waitFor(() => expect(useAppStore.getState().sessions.find(value => value.id === failed.id)).toMatchObject({ hookIngressObservation: { code: 'PRIVATE_STATUS_UNAVAILABLE' } }))
  expect(dom.container.textContent).toContain('Private native Run observation is temporarily unavailable')
  expect(useAppStore.getState().sessions.find(value => value.id === failed.id)?.processState).toBe('running')
  f.inner.kernel.status = nativeStatus
  const healthyBeforeRetry = useAppStore.getState().sessions.find(value => value.id === healthy.agentSessionId)
  const fixed = { ...original, hookBindingId: 'f'.repeat(43), updatedAt: 2 }
  await f.store.compareAndSwap(original, fixed)
  await dom.click('button.small-button')
  await act(async () => { await refresh })
  await vi.waitFor(() => expect(dom.container.querySelector('.terminal-service-window')).toBeNull())
  const current = useAppStore.getState(), session = current.sessions.find(value => value.id === failed.id)!
  expect(session.kind === 'agent' && session.hookIngressObservation).toBeUndefined()
  expect(session.control).toEqual(failed.control); expect(session.processState).toBe('running')
  expect(current.sessions.find(value => value.id === healthy.agentSessionId)).toBe(healthyBeforeRetry)
  expect(healthyBeforeRetry?.control).toEqual(snapshot.sessions.find(value => value.id === healthy.agentSessionId)?.control)
  expect(current.tabs).toEqual(tabs); expect(current.layouts).toEqual(layouts)
  expect(current.agentComposerDrafts[failed.id]).toBe('Original unsent draft')
  if (process.env.AGENTMUX_TEST_HOOK_SCENE) await writeFile(process.env.AGENTMUX_TEST_HOOK_SCENE, JSON.stringify({ failed, recovered: session }, null, 2) + '\n')
})

it('ignores a Hook failure for another Run and keeps unknown Runtime viability explicit', () => {
  const current = useAppStore.getState().sessions[0]!
  const failure = { run: { runId: 'old-run' }, phase: 'listen' as const, code: 'EADDRINUSE', message: 'Private listener unavailable', observedAt: 1 }
  const wrong = { ...current, hookIngressObservation: failure } as SessionSnapshot
  expect(hookIngressServiceOutcome(wrong)).toEqual({ completed: true })
  const unknown = { ...wrong, hookIngressObservation: { ...failure, run: current.control.run }, processState: 'interrupted' as const }
  const notice = classifyServiceNotice(hookIngressServiceOutcome(unknown))
  expect(notice.kind).toBe('indeterminate')
  expect(notice.kind === 'indeterminate' && notice.notice.step).toContain('EADDRINUSE')
})
