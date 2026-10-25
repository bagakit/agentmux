import { afterEach, expect, it, vi } from 'vitest'
import { CtxmuxClient, PROTOCOL_VERSION, type InputChannel, type RunInfo, type RuntimeIdentity } from '@ctxmux/sdk'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { fixturePath } from './helpers/fixture-values.js'

const adapters: CtxmuxRunAdapter[] = []
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.disconnect(); vi.restoreAllMocks() })
const identity = (daemonInstanceId: string): RuntimeIdentity => ({ daemonInstanceId: daemonInstanceId === 'original' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', runtimeId: '33333333-3333-4333-8333-333333333333', runtimeIdPersistence: 'state_dir',
  buildId: 'ctxmuxd/0.1.0', protocolGeneration: PROTOCOL_VERSION, platform: 'macos', arch: 'aarch64', capabilities: {} })
function channel() {
  const closed = Promise.withResolvers<void>()
  const snapshot: RunInfo = { id: 'original-run', spec: { program: 'shell', args: [], cwd: fixturePath('original-cwd'), env: {},
    initial_size: { cols: 80, rows: 24 }, declared_inputs: [] }, lineage: null, backend: { type: 'native' }, native_service: null,
    capabilities: { input: true, resize: true, signal: true, stop: true, fork_level_a: false, fork_level_b: false, replay: 'raw_from_start' },
    pid: 321, state: { type: 'running' }, latest_output_bytes: 0, durable_output_bytes: 0, first_available_byte: 0, attachments: 0,
    applied_input_bytes: 0, current_size: { cols: 80, rows: 24 } }
  const input = vi.fn(async (data: string | Uint8Array) => ({ commandId: 1, receipt: { type: 'input' as const, range: { start_byte: 0, end_byte: Buffer.byteLength(data) } } }))
  const waitWritable = vi.fn(async () => {})
  const close = vi.fn(() => { closed.resolve() })
  return { snapshot, input, waitWritable, close, closed: closed.promise, runtime: identity('original'), retired: closed } as unknown as InputChannel & {
    input: typeof input; close: typeof close; waitWritable: typeof waitWritable; retired: typeof closed
  }
}
function fixture() {
  const adapter = new CtxmuxRunAdapter(); adapters.push(adapter)
  const owner = adapter as unknown as { acceptRuntime(runtime: RuntimeIdentity, ownership: 'owned'): void }
  const accept = (id: string) => owner.acceptRuntime(identity(id), 'owned')
  accept('original')
  return { adapter, accept }
}

it('joins only the physical opening and dispatches independently from its earlier receipt', async () => {
  const h = fixture(), opening = Promise.withResolvers<InputChannel>(), native = channel()
  const open = vi.spyOn(CtxmuxClient.prototype, 'openInput').mockReturnValue(opening.promise)
  const first = h.adapter.openInput('original-run'), second = h.adapter.openInput('original-run')
  opening.resolve(native)
  const [a, b] = await Promise.all([first, second])
  expect(a).toBe(b); expect(open).toHaveBeenCalledTimes(1)
  const ack = Promise.withResolvers<Awaited<ReturnType<InputChannel['input']>>>()
  native.input.mockReturnValueOnce(ack.promise)
  const held = a.input('a'), later = b.input('b')
  expect(native.input.mock.calls.map(([data]) => data)).toEqual(['a', 'b'])
  ack.resolve({ commandId: 1, receipt: { type: 'input', range: { start_byte: 0, end_byte: 1 } } })
  await Promise.all([held, later])
})

it('does not retire an input connection when the output view detaches or an identical Runtime is reobserved', async () => {
  const h = fixture(), native = channel()
  vi.spyOn(CtxmuxClient.prototype, 'openInput').mockResolvedValue(native)
  const input = await h.adapter.openInput('original-run')
  await h.adapter.detach('original-run'); h.accept('original')
  await input.waitWritable(1); await input.input('a')
  expect(native.close).not.toHaveBeenCalled()
  expect(native.input).toHaveBeenCalledTimes(1)
})

it('releases a replaced physical owner and never returns its stale opening to the new Runtime', async () => {
  const h = fixture(), old = channel(), next = channel()
  const open = vi.spyOn(CtxmuxClient.prototype, 'openInput').mockResolvedValueOnce(old).mockResolvedValueOnce(next)
  const previous = await h.adapter.openInput('original-run')
  h.accept('replacement')
  await expect(previous.waitWritable(1)).rejects.toMatchObject({ code: 'CTXMUX_DISCONNECTED', detail: 'not_applied' })
  const current = await h.adapter.openInput('original-run')
  await current.input('current')
  expect(open).toHaveBeenCalledTimes(2); expect(old.close).toHaveBeenCalledTimes(1)
  expect(old.input).not.toHaveBeenCalled(); expect(next.input).toHaveBeenCalledWith('current')
})

it('closes a late original opening without deleting the newer physical owner', async () => {
  const h = fixture(), late = Promise.withResolvers<InputChannel>(), old = channel(), next = channel()
  const open = vi.spyOn(CtxmuxClient.prototype, 'openInput').mockReturnValueOnce(late.promise).mockResolvedValueOnce(next)
  const oldOpening = h.adapter.openInput('original-run'); void oldOpening.catch(() => {})
  await Promise.resolve()
  h.accept('replacement')
  const current = await h.adapter.openInput('original-run')
  late.resolve(old)
  await expect(oldOpening).rejects.toMatchObject({ code: 'CTXMUX_DISCONNECTED', detail: 'not_applied' })
  expect(old.close).toHaveBeenCalledTimes(1)
  expect(await h.adapter.openInput('original-run')).toBe(current)
  expect(open).toHaveBeenCalledTimes(2); expect(next.close).not.toHaveBeenCalled()
})

it('removes a terminal or closed channel so an independent later call cannot inherit it', async () => {
  const h = fixture(), ended = channel(), current = channel()
  const open = vi.spyOn(CtxmuxClient.prototype, 'openInput').mockResolvedValueOnce(ended).mockResolvedValueOnce(current)
  await h.adapter.openInput('original-run'); ended.retired.resolve(); await Promise.resolve()
  await (await h.adapter.openInput('original-run')).input('new')
  expect(open).toHaveBeenCalledTimes(2)
  expect(ended.input).not.toHaveBeenCalled(); expect(current.input).toHaveBeenCalledTimes(1)
  h.adapter.disconnect(); expect(current.close).toHaveBeenCalledTimes(1)
})
