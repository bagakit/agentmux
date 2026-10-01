import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachedSnapshot, RunEvent, RunInfo, TerminalSize } from '@ctxmux/sdk'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import type { AgentMuxRpcOutputInitial, AgentMuxRpcStreamEvent } from '../src/public-rpc.js'
import { encodeHostedValue } from '../src/hosted-value.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

/** Real Core + adapter + public Unix/HTTP owners. Only the original SDK's Native
 * transport is controlled; this fixture does not launch an Agent or a Native Run. */
async function fixture() {
  const h = await rpcOwnerFixture(['output-agent']); cleanups.push(h.close)
  let revision = 7, size: TerminalSize = { cols: 80, rows: 24 }
  let kind: 'not_requested' | 'unknown' | 'basic_vt' = 'not_requested'
  const adapter = new CtxmuxRunAdapter(), native: AttachedSnapshot[] = [], detach = vi.fn()
  const restore = Uint8Array.of(0x1b, 0x63, 0xff, 0, 0xe4, 0xb8, 0xad)
  const info = (): RunInfo => ({ id: 'run-output-agent', spec: { program: 'fixture', args: [], cwd: h.root,
    env: {}, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] }, lineage: null, backend: { type: 'native' },
    capabilities: { input: true, resize: true, signal: true, stop: true, fork_level_a: false, fork_level_b: false, replay: 'raw_from_start' },
    pid: null, state: { type: 'running' }, latest_output_bytes: 3, durable_output_bytes: 3,
    first_available_byte: 0, attachments: 1, applied_input_bytes: 0, native_service: null, current_size: { ...size } })
  const attach = vi.fn(async () => {
    const snapshot: AttachedSnapshot = { run: info(), resize_revision: revision,
      terminal: kind === 'basic_vt' ? { type: kind, checkpoint: { run_id: 'run-output-agent', through_byte: 0,
        resize_revision: revision - 1, size: { cols: 80, rows: 24 }, restore_size: { cols: 91, rows: 9 }, restore_scrollback_rows: 31, resize_after_restore_bytes: 3, restore_bytes: restore.length },
        resizes: [{ through_byte: 2, resize_revision: revision, size: { ...size } }] }
        : kind === 'unknown' ? { type: kind, reason: 'origin_unknown' } : { type: kind },
      terminal_restore: kind === 'basic_vt' ? restore : new Uint8Array(0),
      replay: { chunks: [{ start_byte: 0, end_byte: 3, data: Uint8Array.of(0xe4, 0xb8, 0xad) }],
        first_available_byte: 0, latest_output_bytes: 3, truncated: false } }
    native.push(snapshot)
    let end!: () => void
    const closed = new Promise<void>(resolve => { end = resolve })
    return { snapshot, async *events(): AsyncGenerator<RunEvent> { await closed }, close: end,
      detach: async () => { detach(); end() } }
  })
  const resize = vi.fn(async (_runId: string, requested: TerminalSize) => {
    size = { ...requested }; revision++
    return { run: info(), receipt: { type: 'resize' as const, applied_size: { ...size } } }
  })
  ;(adapter as unknown as { client: unknown }).client = { attach, resize, status: async () => info() }
  h.inner.kernel = adapter as unknown as Record<string, unknown>
  const observed = vi.spyOn(h.client, 'observeAgentOutput'), stop = vi.spyOn(adapter, 'stop'), replace = vi.spyOn(adapter, 'attach')
  const reattach = vi.spyOn(h.client, 'reattachAgent'), replay = vi.spyOn(h.client, 'readRunReplay')
  const path = join(h.root, 'output.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients,
    http: { host: '127.0.0.1', port: 0, token: 'private-output' } })
  await server.start(); cleanups.push(() => server.stop())
  return { ...h, observed, stop, replace, reattach, replay, server, attach, detach, resize, native, restore, path,
    kind(value: typeof kind) { kind = value } }
}

describe('output opening keeps one original Attachment', () => {
  it('retains nonzero revision and terminal absence after a real Core resize, with one attachment read per subscription', async () => {
    const f = await fixture(), openings: AgentMuxRpcOutputInitial[] = []
    const carriers = [{ transport: 'unix' as const, path: f.path },
      { transport: 'http' as const, url: `http://127.0.0.1:${f.server.httpAddress!.port}/`, token: 'private-output' }]
    for (const [index, endpoint] of carriers.entries()) {
      if (index === 1) {
        expect(await f.client.resizeAgent('output-agent', { runId: 'run-output-agent' }, 101, 33)).toEqual({ runId: 'run-output-agent', cols: 101, rows: 33 })
        f.kind('unknown')
      }
      const client = await connectAgentMuxRpc({ endpoint }); cleanups.push(() => client.dispose())
      const events: AgentMuxRpcStreamEvent<'agent.output'>[] = []
      const pending = client.subscribe('agent.output', { agentSessionId: 'output-agent', follow: false }, {
        onInitial: opening => { openings.push(opening) }, onEvent: event => events.push(event) })
      await expect(pending).resolves.toMatchObject({ subscriptionId: expect.any(String) })
      const reader = await pending
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('end'))
      expect(f.observed).toHaveBeenCalledTimes(index + 1); expect(f.attach).toHaveBeenCalledTimes(index + 1)
      const attached = await f.observed.mock.results[index]!.value
      expect(openings[index]!.resizeRevision).toBe(attached.attachment.resizeRevision)
      expect(openings[index]!.terminal).toEqual(attached.attachment.terminal)
      expect(openings[index]!.run).toEqual(attached.attachment.run)
      expect(openings[index]!.resizeRevision).toBe(f.native[index]!.resize_revision)
      expect(events.filter(event => event.type === 'output').flatMap(event => [...Buffer.from(event.data.dataBase64, 'base64')])).toEqual([0xe4, 0xb8, 0xad])
      await reader.dispose(); await client.dispose()
    }
    expect(openings.map(opening => [opening.resizeRevision, opening.terminal, opening.run.cols, opening.run.rows])).toEqual([
      [7, { type: 'not-requested' }, 80, 24], [8, { type: 'unknown', reason: 'origin_unknown' }, 101, 33]
    ])
    expect(f.resize).toHaveBeenCalledOnce(); await vi.waitFor(() => expect(f.detach).toHaveBeenCalledTimes(2))
    expect(f.reattach).not.toHaveBeenCalled(); expect(f.replay).not.toHaveBeenCalled(); expect(f.replace).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  })

  it('keeps original checkpoint, resize tail and synthetic Uint8Array bytes distinct from output over the real wire', async () => {
    const f = await fixture(); f.kind('basic_vt')
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.path } }); cleanups.push(() => client.dispose())
    const openings: AgentMuxRpcOutputInitial[] = [], frames: unknown[] = [], events: AgentMuxRpcStreamEvent<'agent.output'>[] = []
    const reader = await client.subscribe('agent.output', { agentSessionId: 'output-agent', follow: false }, {
      onInitial: value => openings.push(value), onFrame: value => frames.push(value), onEvent: value => events.push(value) })
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('end'))
    expect(openings).toHaveLength(1); expect(frames).toHaveLength(3)
    const opening = openings[0]!, attached = await f.observed.mock.results[0]!.value
    expect(opening.terminal).toEqual(attached.attachment.terminal); expect(opening.resizeRevision).toBe(7)
    expect(opening.terminal.type).toBe('basic-vt')
    if (opening.terminal.type !== 'basic-vt') throw new Error('The original terminal scope was lost')
    expect(opening.terminal.restoreBytes).toBeInstanceOf(Uint8Array); expect(opening.terminal.restoreBytes).toEqual(f.restore)
    expect(opening.terminal.checkpoint).toEqual({ runId: 'run-output-agent', throughByte: 0, resizeRevision: 6, size: { cols: 80, rows: 24 }, restoreSize: { cols: 91, rows: 9 }, restoreScrollbackRows: 31, resizeAfterRestoreBytes: 3 })
    expect(opening.terminal.resizes).toEqual([{ throughByte: 2, resizeRevision: 7, size: { cols: 80, rows: 24 } }])
    expect(frames[0]).toMatchObject({ result: { initial: { resizeRevision: 7, terminal: { restoreBytes: encodeHostedValue(f.restore) } } } })
    expect(events.filter(event => event.type === 'output').flatMap(event => [...Buffer.from(event.data.dataBase64, 'base64')])).toEqual([0xe4, 0xb8, 0xad])
    expect(f.attach).toHaveBeenCalledOnce(); await reader.dispose(); await vi.waitFor(() => expect(f.detach).toHaveBeenCalledOnce())
    expect(f.stop).not.toHaveBeenCalled(); expect(f.replace).not.toHaveBeenCalled()
  })

  it('rejects missing, fabricated or foreign terminal facts instead of filling unknown with zero or not-requested', async () => {
    const f = await fixture(), session = f.client.agentSession('output-agent'), run = (await f.client.statusAgent('output-agent')).run
    const basic = { type: 'basic-vt', checkpoint: { runId: run.runId, throughByte: 0, resizeRevision: 6, size: { cols: 80, rows: 24 },
      restoreSize: { cols: 91, rows: 9 }, restoreScrollbackRows: 31, resizeAfterRestoreBytes: 3 },
      restoreBytes: encodeHostedValue(f.restore), resizes: [{ throughByte: 2, resizeRevision: 7, size: { cols: 80, rows: 24 } }] }
    const cases = [
      { terminal: { type: 'not-requested' } }, { resizeRevision: 7 },
      { terminal: { type: 'not-requested' }, resizeRevision: -1 }, { terminal: { type: 'not-requested' }, resizeRevision: 7.5 },
      { terminal: { type: 'unknown', reason: 'guessed' }, resizeRevision: 7 },
      { terminal: { type: 'unknown', reason: ['origin_unknown'] }, resizeRevision: 7 },
      { terminal: { ...basic, checkpoint: { ...basic.checkpoint, runId: 'foreign-run' } }, resizeRevision: 7 },
      { terminal: { ...basic, resizes: [{ ...basic.resizes[0]!, resizeRevision: 8 }] }, resizeRevision: 7 },
      { terminal: { ...basic, restoreBytes: { 0: 27, 1: 99 } }, resizeRevision: 7 },
      { terminal: { ...basic, checkpoint: { ...basic.checkpoint, resizeAfterRestoreBytes: f.restore.length + 1 } }, resizeRevision: 7 },
      { terminal: { ...basic, checkpoint: { ...basic.checkpoint, restoreSize: { cols: 0, rows: 9 } } }, resizeRevision: 7 },
      { terminal: { ...basic, checkpoint: { ...basic.checkpoint, restoreScrollbackRows: -1 } }, resizeRevision: 7 }
    ]
    expect(cases).toHaveLength(12)
    for (const [index, facts] of cases.entries()) {
      const path = join(f.root, `invalid-${index}.sock`), initial = vi.fn(), events = vi.fn()
      const server = createServer(socket => socket.once('data', chunk => {
        const request = JSON.parse(chunk.toString())
        socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { subscriptionId: 'original-reader', method: 'agent.output',
          initial: { session, run, gap: null, ...facts } } }) + '\n')
      }))
      await new Promise<void>(resolve => server.listen(path, resolve))
      const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
      try {
        await expect(client.subscribe('agent.output', { agentSessionId: 'output-agent', follow: false }, { onInitial: initial, onEvent: events })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
        expect(initial).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled()
      } finally { await client.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) }
    }
    expect(f.attach).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  })
})
