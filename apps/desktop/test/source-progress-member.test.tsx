// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { readSpaceSnapshot } from '../../../packages/core/src/space-authority-stream'
import { createSourceNativeMemberFixture } from './helpers/source-native-member-fixture'
import { sourceMemberImageRetention, sourceMemberProgress } from '../src/renderer/src/lib/source-member-tools'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })



it('an obtained original progress ACK crosses Core, Main, Preload and Renderer after Source removal and reader cancellation', async () => {
  const f = await createSourceNativeMemberFixture(cleanup), controller = new AbortController()
  const replacement = vi.fn(async () => { throw Error('A replacement carrier must not replay this original effect') })
  f.afterExecutionAck(async method => {
    if (method !== 'agent.progress.create') return
    const snapshot = await readSpaceSnapshot(f.b.rpc, f.selected.target.reference)
    const region = snapshot.scope.regions.find(region => region.regionId === f.selected.target.regionId)!
    await f.b.rpc.call('space.apply', { reference: f.selected.target.reference, expectedRevision: snapshot.revision,
      changes: { remove: { tabs: [region.tabId], regions: [region.regionId] } } })
  })
  f.afterReply(method => { if (method === 'agent.progress.create') {
    f.main.routes.set('original-progress-source', { client: { forwardRpc: replacement, subscribeRpc: f.rpc.subscribe.bind(f.rpc) } } as never)
    controller.abort(new Error('This reply reader was dismissed after obtaining the original ACK'))
  } })
  const result = await f.surface.call('agent.progress.create', { target: f.selected.inputTarget, intervalMs: 60_000,
    prompt: 'Original explicit Source arrangement', operationId: 'original-four-layer-ACK' }, controller.signal)
  expect(controller.signal.aborted).toBe(true)
  expect(result).toMatchObject({ diskDurability: 'confirmed', loop: { creationOperationId: 'original-four-layer-ACK', status: 'active' } })
  expect(f.calls.filter(method => method === 'agent.progress.create')).toHaveLength(1)
  expect(replacement).not.toHaveBeenCalled()
  expect(f.selected.progress.list()).toHaveLength(1)
  expect(f.tick).not.toHaveBeenCalled(); expect(f.selected.owner.inner.kernel.input).not.toHaveBeenCalled(); expect(f.selected.owner.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a cancelled original progress read still rejects after its result without publishing a replacement observation', async () => {
  const f = await createSourceNativeMemberFixture(cleanup), controller = new AbortController()
  f.afterReply(method => { if (method === 'agent.progress.list') controller.abort(new Error('The original read was cancelled')) })
  const result = await f.surface.call('agent.progress.list', { target: f.selected.inputTarget }, controller.signal)
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  expect(result.value).toBeUndefined()
  expect(result.error).toBeDefined()
  expect(f.calls.filter(method => method === 'agent.progress.list')).toHaveLength(1)
  expect(f.selected.progress.list()).toEqual([])
})

it('the original image adapter keeps one unknown upload operation through Main and can inspect its original Run after replacement', async () => {
  const f = await createSourceNativeMemberFixture(cleanup), original = (await f.selected.owner.store.readMetadata('recipient'))!
  const { kind: _purpose, ...identity } = f.selected.target, target = { hostId: 'original-progress-source', target: { ...identity, expectedRun: original.run } }
  let lost = false
  f.afterReply(method => { if (method === 'file.upload' && !lost) { lost = true; throw new Error('The original upload reply was lost after its bytes were saved') } })
  const retainImage = sourceMemberImageRetention(f.main.api, target)
  const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i8egAAAAASUVORK5CYII=', 'base64'))
  const result = await retainImage(bytes, 'image/png')
  expect(result).toMatchObject({ observation: 'unavailable', upload: { hostId: 'local', agentSessionId: 'recipient', expectedRun: original.run }, issue: { message: 'The original upload reply was lost after its bytes were saved' } })
  expect(f.calls.filter(method => method === 'file.upload')).toHaveLength(1)
  const current = (await f.selected.owner.store.readMetadata('recipient'))!
  await f.selected.owner.store.compareAndSwap(current, { ...current, run: { runId: 'later-original-image-run' }, updatedAt: current.updatedAt + 1 })
  await f.selected.owner.inner.registry.refresh('recipient', { runId: 'later-original-image-run' })
  const reader = await f.main.api.member(target, () => {})
  try {
    const receipt = await reader.call('file.upload.inspect', result.upload)
    expect(receipt).toMatchObject({ ...result.upload, status: 'uploaded' })
  } finally { await reader.dispose() }
  expect(f.calls.filter(method => method === 'file.upload')).toHaveLength(1)
  expect(f.selected.owner.inner.kernel.input).not.toHaveBeenCalled(); expect(f.selected.owner.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the common progress adapter reads the original epoch and creates through its explicit Session purpose without local APIs', async () => {
  const f = await createSourceNativeMemberFixture(cleanup), original = sourceMemberProgress(f.main.api, { hostId: 'original-progress-source', target: f.selected.target },
    { providerId: f.selected.inputTarget.providerId, workspacePath: f.selected.inputTarget.workspacePath })
  const epoch = await original.readInputEpoch()
  const loop = await original.port.create({ target: original.target, intervalMs: 60_000, prompt: 'Original adapter future input', operationId: 'original-adapter-progress', ...(epoch ? { inputEpoch: epoch } : {}) })
  expect(loop).toMatchObject({ creationOperationId: 'original-adapter-progress', workspacePath: f.selected.owner.root })
  expect(await original.port.list(original.target)).toEqual([loop])
  expect(await original.port.list(original.target, 'original-adapter-progress')).toEqual([loop])
  expect(await original.port.list(original.target, 'not-the-original-operation')).toEqual([])
  expect(f.calls).toContain('agent.progress.create')
  expect(f.selected.owner.inner.kernel.input).not.toHaveBeenCalled()
})
