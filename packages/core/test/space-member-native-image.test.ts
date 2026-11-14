import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createSpaceMemberProgressFixture } from './helpers/space-member-progress-fixture.js'
import { fileUploadRevision } from '../src/public-rpc-files.js'
import { parseSpaceMemberParams } from '../src/space-member-codec.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i8egAAAAASUVORK5CYII=', 'base64')

it.each([false, true])('the original member image upload retains original bytes and can inspect its old Run operation (foreign: %s)', async foreign => {
  const f = await createSpaceMemberProgressFixture(cleanup), selected = await f.admit(foreign), original = (await selected.owner.store.readMetadata('recipient'))!
  const { kind: _purpose, ...identity } = selected.target, target = { ...identity, expectedRun: original.run }
  const upload = { hostId: 'local', agentSessionId: 'recipient', expectedRun: original.run, operationId: 'original-native-image-operation',
    name: 'image', mimeType: 'image/png', byteLength: bytes.byteLength, revision: fileUploadRevision(bytes) }
  const native = vi.spyOn(selected.owner.client, 'runtimeSubject').mockRejectedValue(Error('Native observation is unavailable, not image upload permission'))
  const uploaded = await f.rpc.call('space.member.call', { target, call: { method: 'file.upload', params: { ...upload, dataBase64: bytes.toString('base64') } } }) as typeof upload & { status: string; path: string }
  expect(uploaded).toMatchObject({ ...upload, status: 'uploaded' })
  expect(await readFile(uploaded.path)).toEqual(bytes)
  const current = (await selected.owner.store.readMetadata('recipient'))!
  await selected.owner.store.compareAndSwap(current, { ...current, run: { runId: 'new-original-run' }, updatedAt: current.updatedAt + 1 })
  await selected.owner.inner.registry.refresh('recipient', { runId: 'new-original-run' })
  const receipt = await f.rpc.call('space.member.call', { target, call: { method: 'file.upload.inspect', params: upload } })
  expect(receipt).toEqual(uploaded)
  if (!foreign) {
    const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.original.root + '/B.sock', 'space', 'member', 'call', '--input', '-'],
      objectCliEnvironment(selected.owner.root), JSON.stringify({ target, call: { method: 'file.upload.inspect', params: upload } }))
    expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(uploaded)
  }
  await expect(f.rpc.call('space.member.call', { target, call: { method: 'file.upload', params: { ...upload, operationId: 'not-permitted-on-old-run', dataBase64: bytes.toString('base64') } } })).rejects.toMatchObject({ code: 'FILE_UPLOAD_TARGET_MISMATCH' })
  expect(native).not.toHaveBeenCalled()
  expect(selected.owner.inner.kernel.input).not.toHaveBeenCalled(); expect(selected.owner.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a conversation or Session purpose cannot upload, and every upload keeps the exact original SID, Run and C/L', () => {
  const target = { reference: { runtimeId: 'B', spaceId: 'original' }, regionId: 'original-region', runtimeId: 'D', agentSessionId: 'recipient',
    expectedRun: { runId: 'original-run' }, expectedAdmission: { kind: 'creation' as const, operationId: 'original-C' } }
  const input = { hostId: 'local', agentSessionId: 'recipient', expectedRun: target.expectedRun, operationId: 'original-image', name: 'image', mimeType: 'image/png', byteLength: bytes.byteLength, revision: fileUploadRevision(bytes), dataBase64: bytes.toString('base64') }
  expect(() => parseSpaceMemberParams('space.member.call', { target, call: { method: 'file.upload', params: input } })).not.toThrow()
  const { expectedRun: _run, ...durable } = target, { expectedAdmission: _C, ...unpinned } = target
  for (const refused of [{ ...durable, kind: 'conversation' }, { ...durable, kind: 'session' }, unpinned])
    expect(() => parseSpaceMemberParams('space.member.call', { target: refused, call: { method: 'file.upload', params: input } })).toThrow()
  for (const params of [{ ...input, hostId: 'observer' }, { ...input, agentSessionId: 'another-agent' }, { ...input, expectedRun: { runId: 'another-run' } }])
    expect(() => parseSpaceMemberParams('space.member.call', { target, call: { method: 'file.upload', params } })).toThrow()
})
