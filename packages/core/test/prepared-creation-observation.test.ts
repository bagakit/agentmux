import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CtxmuxClient, PROTOCOL_VERSION, type RunInfo, type RunSpec, type RuntimeIdentity } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxPreparedTerminal } from '../src/terminal-preparation.js'

const closes: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const operationKey = 'original-capsule-creation'
const runId = '03bdc29a-63ce-4ab5-8051-cee01f188eda'

/** Real Core/adapter/SDK over a finite public wire. Native fault recovery is separately qualified. */
async function fixture(supported = true) {
  const root = await mkdtemp(join(tmpdir(), 'amx-creation-wire-')), path = join(root, 'native.sock')
  const spec: RunSpec = { program: '/bin/sh', args: ['service-entry'], cwd: root,
    env: { AGENTMUX_LIFECYCLE_OPERATION_ID: operationKey, SERVICE_VALUE: 'original' },
    initial_size: { cols: 80, rows: 24 }, declared_inputs: [] }
  const run: RunInfo = { id: runId, spec, lineage: null, backend: { type: 'native' },
    capabilities: { input: true, resize: true, signal: true, stop: true, fork_level_a: true,
      fork_level_b: true, replay: 'raw_from_start' }, pid: 4321, state: { type: 'running' },
    latest_output_bytes: 0, durable_output_bytes: 0, first_available_byte: 0,
    attachments: 0, applied_input_bytes: 0, current_size: { cols: 80, rows: 24 },
    native_service: { revision: 1, owner: { type: 'serving' }, output: { type: 'serving' },
      input: { phase: { type: 'open' }, unsettled_commands: 0, unsettled_request_bytes: 0,
        write_blocked: false, completed_input_bytes: 0, current_size: { cols: 80, rows: 24 },
        active_confirmed_bytes: 0 }, terminal_fault: null } }
  const runtime: RuntimeIdentity = { daemonInstanceId: randomUUID(), runtimeId: randomUUID(),
    runtimeIdPersistence: 'state_dir', buildId: 'ctxmuxd/private-creation-wire', protocolGeneration: PROTOCOL_VERSION,
    platform: 'macos', arch: 'aarch64', capabilities: supported ? { 'services.creation_observation': 1 } : {} }
  const state = { outcome: 'retained', returnedKey: operationKey, run: structuredClone(run), unavailable: false }
  const requests: Array<Record<string, unknown>> = [], sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let pending = ''
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      pending += chunk
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n'), frame = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1)
        const send = (value: unknown) => socket.write(JSON.stringify(value) + '\n')
        if (frame.type === 'hello') { send({ type: 'hello', runtime }); continue }
        const request = frame.request; requests.push(request)
        if (request.type === 'observe_creation' && !state.unavailable) send({ type: 'response', response: {
          type: 'creation_observation', observation: { outcome: state.outcome, operation_key: state.returnedKey,
            ...(state.outcome === 'retained' ? { run: state.run } : {}) } } })
        else if (request.type === 'status' && request.id === runId) send({ type: 'response', response: { type: 'status', run } })
        else send({ type: 'error', error: { code: 'backend_unavailable', message: 'Original observation unavailable.' } })
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  closes.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  closes.push(() => client.dispose())
  const inner = client as unknown as { connected: boolean; kernel: CtxmuxRunAdapter }
  inner.connected = true
  const native = inner.kernel as unknown as { client: CtxmuxClient; runtime: RuntimeIdentity }
  native.client = new CtxmuxClient({ socketPath: path, expectedRuntimeIdentity: runtime }); native.runtime = runtime
  const prepared: AgentMuxPreparedTerminal = { createOperationId: operationKey, workspacePath: root,
    launch: JSON.stringify({ createOperationId: operationKey, request: spec }) }
  return { client, inner, native, state, requests, prepared }
}

describe('prepared creation uses the original Native key through the real SDK', () => {
  it('observes one exact creation without consulting an unrelated inventory or sending effects', async () => {
    const f = await fixture(), before = structuredClone(f.prepared)
    await expect(f.client.inspectPreparedTerminal(f.prepared)).resolves.toMatchObject({ runId, pid: 4321, kind: 'terminal' })
    expect(f.requests).toEqual([{ type: 'observe_creation', operation_key: operationKey }])
    expect(f.prepared).toEqual(before)
  })

  it('keeps not-retained unknown and inspects the same operation when its original mapping becomes visible', async () => {
    const f = await fixture(); f.state.outcome = 'not_retained'
    await expect(f.client.inspectPreparedTerminal(f.prepared)).resolves.toBeNull()
    f.state.outcome = 'retained'
    await expect(f.client.inspectPreparedTerminal(f.prepared)).resolves.toMatchObject({ runId })
    expect(f.requests).toEqual(Array.from({ length: 2 }, () => ({ type: 'observe_creation', operation_key: operationKey })))
  })

  it('rejects an observation echoed for another creation key at the actual SDK boundary', async () => {
    const f = await fixture(); f.state.returnedKey = 'foreign-creation'
    await expect(f.client.inspectPreparedTerminal(f.prepared)).rejects.toThrow('exact creation observation')
    expect(f.requests).toEqual([{ type: 'observe_creation', operation_key: operationKey }])
    expect(f.inner.kernel.isConnected()).toBe(true)
  })

  it('refuses a retained original key whose complete frozen launch differs', async () => {
    const f = await fixture(); f.state.run.spec!.env.SERVICE_VALUE = 'changed'
    await expect(f.client.inspectPreparedTerminal(f.prepared)).rejects.toMatchObject({ code: 'TERMINAL_CREATION_UNCONFIRMED' })
    expect(f.requests).toEqual([{ type: 'observe_creation', operation_key: operationKey }])
  })

  it('scopes unavailable optional observation to this read while exact bound Run status remains available', async () => {
    const f = await fixture(false)
    await expect(f.client.inspectPreparedTerminal(f.prepared)).rejects.toThrow('services.creation_observation')
    expect(f.requests).toEqual([])
    await expect(f.client.inspectPreparedTerminal(f.prepared, { runId })).resolves.toMatchObject({ runId })
    expect(f.requests).toEqual([{ type: 'status', id: runId }])
    expect(f.inner.kernel.isConnected()).toBe(true)
  })

  it('retains unavailable observation without replacing it with an inventory, Start or negative receipt', async () => {
    const f = await fixture(); f.state.unavailable = true
    await expect(f.client.inspectPreparedTerminal(f.prepared)).rejects.toMatchObject({ code: 'CTXMUX_backend_unavailable' })
    expect(f.requests).toEqual([{ type: 'observe_creation', operation_key: operationKey }])
    await expect(f.client.inspectPreparedTerminal(f.prepared, { runId })).resolves.toMatchObject({ runId })
    expect(f.requests.map(request => request.type)).toEqual(['observe_creation', 'status'])
  })
})
