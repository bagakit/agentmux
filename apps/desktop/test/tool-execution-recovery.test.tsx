// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentExecutionBindingService, type AgentExecutionHostPort, type AgentExecutionInspection } from '../../../packages/core/src/agent-execution-coordinator'
import type { AgentMuxClientEvent } from '../../../packages/core/src/types'
import { registerExecutionBindingIpc } from '../src/main/execution-binding-ipc'
import { ExecutionBindingReaders } from '../src/main/execution-binding-readers'
import { createExecutionBindingApi } from '../src/preload/execution-binding'
import { AgentToolExecutionNotice } from '../src/renderer/src/components/AgentToolExecutionNotice'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const session = { ...composerSession('original-agent'), toolExecution: { bindingId: 'original-binding', resourceHostId: 'tools', workspacePath: '/original/project' } }
const fact = (): AgentExecutionInspection => ({ bindingId: 'original-binding', agentHostId: 'local', agentSessionId: 'original-agent', resourceHostId: 'tools', resourceWorkspacePath: '/original/project', state: 'connected' })
const render = () => dom.render(<AgentToolExecutionNotice session={session} visible presentation="inline" />)
async function click(label: string) {
  const button = [...dom.container.querySelectorAll('button')].find(node => node.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
function pending<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.each(['old-first', 'new-first'])('keeps the latest requested refresh failure (%s), not the first response', async order => {
  vi.spyOn(api.sessions, 'observeExecutionBinding').mockImplementation((_id, emit) => { emit(fact()); return vi.fn() })
  const older = pending<AgentExecutionInspection>(), newer = pending<AgentExecutionInspection>()
  vi.spyOn(api.sessions, 'executionBinding').mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  await render(); await click('Refresh observation'); await click('Refresh observation')
  const old = () => act(async () => older.resolve(fact()))
  const next = () => act(async () => newer.reject(new Error('Latest requested read unavailable')))
  if (order === 'old-first') { await old(); await next() } else { await next(); await old() }
  expect(dom.container.textContent).toContain('Latest requested read unavailable')
  expect(dom.container.textContent).toContain('Last confirmed tool connection: connected')
})

it('keeps a newer successful read and a newer subscription ahead of earlier pending reads', async () => {
  let emit!: (value: AgentExecutionInspection) => void
  vi.spyOn(api.sessions, 'observeExecutionBinding').mockImplementation((_id, listener) => { emit = listener; return vi.fn() })
  const older = pending<AgentExecutionInspection>(), newer = pending<AgentExecutionInspection>(), last = pending<AgentExecutionInspection>()
  vi.spyOn(api.sessions, 'executionBinding').mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise).mockReturnValueOnce(last.promise)
  await render(); await click('Refresh observation'); await click('Refresh observation')
  await act(async () => newer.resolve(fact()))
  await act(async () => older.reject(new Error('Superseded failure')))
  expect(dom.container.textContent).toContain('Tool connection · Connected')
  expect(dom.container.textContent).not.toContain('Superseded failure')
  await click('Refresh observation')
  await act(async () => emit({ ...fact(), state: 'unavailable', diagnostic: { code: 'READER_DOWN', message: 'Current subscription lost its reader' } }))
  await act(async () => last.resolve(fact()))
  expect(dom.container.textContent).toContain('Current subscription lost its reader')
})

it('shows scoped unresolved operations without declaring a healthy connection unavailable', async () => {
  vi.spyOn(api.sessions, 'observeExecutionBinding').mockImplementation((_id, emit) => { emit({ ...fact(), diagnostics: [
    { scope: 'operation', side: 'executor', runId: 'original-helper', generation: 'generation-1', operation: { bindingId: 'original-binding', streamGeneration: 'generation-1', nativeRequestId: 7 }, code: 'UNKNOWN', message: 'Original numeric operation unresolved' },
    { scope: 'operation', side: 'executor', runId: 'original-helper', generation: 'generation-1', operation: { bindingId: 'original-binding', streamGeneration: 'generation-1', nativeRequestId: '7' }, code: 'UNKNOWN', message: 'Original string operation unresolved' }
  ] }); return vi.fn() })
  await render()
  expect(dom.container.textContent).toContain('Tool connection · Connected')
  expect(dom.container.textContent).toContain('Operation 7 · generation generation-1')
  expect(dom.container.textContent).toContain('Operation "7" · generation generation-1')
  expect(dom.container.textContent).toContain('Original numeric operation unresolved')
  expect(dom.container.textContent).toContain('Original string operation unresolved')
  expect(dom.container.textContent).not.toContain('Tool execution observation is unconfirmed')
})

/** Actual component/preload/Main/Core service. Only the two external Host ports are controlled. */
async function originalConnection() {
  const directory = await mkdtemp(join(tmpdir(), 'amux-settings-rejoin-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  function host(role: string) {
    const runId = `${role}-original-run`, listeners = new Set<(event: AgentMuxClientEvent) => void>(), errors = new Set<(error: { message: string }) => void>()
    const port = {
      runtimeIdentity: () => ({ instanceId: `${role}-instance` }),
      prepareAgentExecutionHelper: vi.fn(async (prepared: unknown) => ({ prepared })),
      inspectPreparedTerminal: vi.fn(async () => ({ runId, state: 'running' })),
      createPreparedTerminal: vi.fn(async () => ({ runId, state: 'running' })),
      listHostExecutors: async () => ({ executors: [{ executorId: 'fixture', providerId: 'fixture', configRevision: 'r1' }] }),
      readAgentSession: async () => null,
      createHostAgentWithDelivery: vi.fn(async () => ({ session: { agentSessionId: 'original-agent' } })),
      onRunEvent: vi.fn((_id: string, listener: (event: AgentMuxClientEvent) => void, options: { onError(error: { message: string }): void }) => {
        listeners.add(listener); errors.add(options.onError)
        return () => { listeners.delete(listener); errors.delete(options.onError) }
      }),
      attachTerminal: vi.fn(async () => ({ run: { runId, state: 'running' }, gap: null, replay: [] })),
      releaseRunAttachment: vi.fn(async () => {}),
      writeTerminal: vi.fn(async () => { throw new Error('No input belongs to this reader-only fixture') })
    }
    return { port, runId, fault: () => { for (const error of errors) error({ message: 'Original observer disconnected' }) } }
  }
  const agent = host('agent'), tools = host('tools')
  const readers = new ExecutionBindingReaders(id => service.inspect(id))
  const service = new AgentExecutionBindingService(directory, { resolveHost: async id => ({ runtimeId: `${id}-runtime`, client: (id === 'local' ? agent : tools).port as unknown as AgentExecutionHostPort }), onObservation: value => readers.publish(value) })
  cleanup.push(async () => { readers.dispose(); await service.dispose() })
  await service.create({ bindingId: 'original-binding', agentHostId: 'local', agentRuntimeId: 'local-runtime', resourceHostId: 'tools', resourceRuntimeId: 'tools-runtime', resourceWorkspacePath: '/original/project', resourceGrant: { scope: 'host-user', bindingId: 'original-binding' }, agent: { agentSessionId: 'original-agent', createOperationId: 'original-create', executorId: 'fixture', executorRevision: 'r1', workspacePath: '/agent/project' } })
  const renderer = new EventEmitter(), sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (channel: string, value: unknown) => renderer.emit(channel, {}, value) })
  const handlers = new Map<string, (...args: any[]) => unknown>()
  let trusted = true
  registerExecutionBindingIpc({ handle: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: () => { if (!trusted) throw new Error('Sender is not the original trusted Desktop') }, bindings: service, readers })
  const invokes: { channel: string; values: unknown[] }[] = []
  const transport = createExecutionBindingApi({ invoke: async (channel, ...values) => { invokes.push({ channel, values }); return await handlers.get(channel)!({ sender }, ...values) }, on: (channel, listener) => { renderer.on(channel, listener); return renderer as any }, off: (channel, listener) => { renderer.off(channel, listener); return renderer as any } })
  vi.spyOn(api.sessions, 'executionBinding').mockImplementation(transport.executionBinding)
  vi.spyOn(api.sessions, 'rejoinExecutionBinding').mockImplementation(transport.rejoinExecutionBinding)
  vi.spyOn(api.sessions, 'observeExecutionBinding').mockImplementation(transport.observeExecutionBinding)
  return { agent, tools, service, invokes, deny: () => { trusted = false } }
}

it('rejoins the exact retained binding through preload/Main/Core; refresh remains read-only', async () => {
  const f = await originalConnection(), before = useAppStore.getState()
  const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
  await render()
  await act(async () => f.tools.fault())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Tool connection · Unavailable'))
  const attaches = f.tools.port.attachTerminal.mock.calls.length
  await click('Refresh observation')
  expect(f.tools.port.attachTerminal).toHaveBeenCalledTimes(attaches)
  await click('Reconnect original tools')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Tool connection · Connected'))
  expect(f.tools.port.attachTerminal).toHaveBeenCalledTimes(attaches + 1)
  expect(f.tools.port.attachTerminal.mock.calls.at(-1)?.[0]).toBe(f.tools.runId)
  expect(f.invokes.filter(value => value.channel === 'sessions:rejoinExecutionBinding')).toEqual([{ channel: 'sessions:rejoinExecutionBinding', values: ['original-binding'] }])
  for (const host of [f.agent, f.tools]) {
    expect(host.port.createPreparedTerminal).not.toHaveBeenCalled()
    expect(host.port.prepareAgentExecutionHelper).toHaveBeenCalledTimes(1)
    expect(host.port.writeTerminal).not.toHaveBeenCalled()
  }
  expect(f.agent.port.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})

it('keeps an explicit trusted-sender rejection visible without rejoining or removing the original work', async () => {
  const f = await originalConnection()
  await render(); await act(async () => f.tools.fault())
  const attaches = f.tools.port.attachTerminal.mock.calls.length
  f.deny(); await click('Reconnect original tools')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Sender is not the original trusted Desktop'))
  expect(f.tools.port.attachTerminal).toHaveBeenCalledTimes(attaches)
  expect(await f.service.inspect('original-binding')).toMatchObject({ agentSessionId: 'original-agent' })
})
