import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { decodeMoteAvatar } from '../src/main/mote-avatar-image'
import { MOTE_AVATAR_INPUT_MAX_BYTES, isMoteAvatarRef } from '../src/shared/mote-avatars'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, SCRATCH_TOPIC_WIKI_PATH } from '../src/shared/scratch-topics'
import { directoryIdentity } from '../src/shared/space-addresses'
import { scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { controlledNativeImage, imageInput, imagePng } from './fixtures/mote-identity-image'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'mote-avatar-assets-')); roots.push(path)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path, name: 'Space', kind: 'folder' as const }
  const service = new ScratchTopics(controlledNativeImage)
  const topic = await service.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  return { workspace, service, topic, directory: join(path, topic.directoryPath) }
}
it('writes only the confirmed target content asset and reads its exact bounded regular file without altering Mote files', async () => {
  const { workspace, service, topic, directory } = await fixture()
  const soul = await readFile(join(directory, 'SOUL.md'))
  const preview = await service.previewAvatar(workspace, topic.id, imageInput(), directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(topic.id))))
  expect(preview).toMatchObject({ width: 256, height: 256 })
  expect(await readdir(join(directory, '.agentmux'))).not.toContain('avatars')
  const ref = await service.saveAvatar(workspace, topic.id, imageInput(), directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(topic.id))))
  expect(isMoteAvatarRef(ref)).toBe(true)
  expect(await readdir(join(directory, '.agentmux', 'avatars'))).toEqual([ref.fileName])
  expect(await service.saveAvatar(workspace, topic.id, imageInput(), directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(topic.id))))).toEqual(ref)
  expect(await service.readAvatar(workspace, topic.id, ref, directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(topic.id))))).toEqual(preview)
  expect(await readFile(join(directory, 'SOUL.md'))).toEqual(soul)
  const custom = await service.ensureMote(workspace, 'view:custom')
  await expect(service.readAvatar(workspace, custom.id, ref, directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(custom.id))))).rejects.toThrow()
  await expect(service.saveAvatar(workspace, 'view:missing', imageInput(), directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName('view:missing'))))).rejects.toThrow()
})
it('rejects malformed, animated, undecodable, oversized and non-crop images before accepting an asset', async () => {
  const { workspace, service, topic, directory } = await fixture()
  const input = imageInput()
  await expect(service.saveAvatar(workspace, topic.id, { ...input, dataUrl: 'data:image/png;base64,bad' }, directoryIdentity(workspace.hostId, join(workspace.path, topic.directoryPath)))).rejects.toThrow()
  await expect(service.previewAvatar(workspace, topic.id, imageInput(Buffer.alloc(MOTE_AVATAR_INPUT_MAX_BYTES + 1)), directoryIdentity(workspace.hostId, join(workspace.path, topic.directoryPath)))).rejects.toThrow()
  await expect(service.previewAvatar(workspace, topic.id, imageInput(imagePng(4097, 1)), directoryIdentity(workspace.hostId, join(workspace.path, topic.directoryPath)))).rejects.toThrow('4096')
  await expect(service.saveAvatar(workspace, topic.id, imageInput(imagePng(128, 128)), directoryIdentity(workspace.hostId, join(workspace.path, topic.directoryPath)))).rejects.toThrow('256')
  const animated = Buffer.concat([imagePng().subarray(0, 33), Buffer.from([0, 0, 0, 0]), Buffer.from('acTL'), Buffer.alloc(4)])
  expect(() => decodeMoteAvatar(imageInput(animated), controlledNativeImage)).toThrow('static')
  const unsupportedDecode = vi.fn(controlledNativeImage)
  expect(() => decodeMoteAvatar({ ...input, mimeType: 'image/webp' } as never, unsupportedDecode)).toThrow('PNG or JPEG')
  expect(unsupportedDecode).not.toHaveBeenCalled()
  expect(() => decodeMoteAvatar(input, () => ({ isEmpty: () => true }) as never)).toThrow('decoded')
  expect(await readdir(join(directory, '.agentmux'))).not.toContain('avatars')
})
it('rejects asset reference traversal, regular-file replacement, hash tampering and directory symlinks', async () => {
  const { workspace, service, topic, directory } = await fixture()
  const ref = await service.saveAvatar(workspace, topic.id, imageInput(), directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(topic.id))))
  await expect(service.readAvatar(workspace, topic.id, { kind: 'image', fileName: '../SOUL.md' }, directoryIdentity(workspace.hostId, join(workspace.path, topic.directoryPath)))).rejects.toThrow()
  const asset = join(directory, '.agentmux', 'avatars', ref.fileName)
  await writeFile(asset, imagePng(256, 256, [199, 0, 0]))
  await expect(service.readAvatar(workspace, topic.id, ref, directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(topic.id))))).rejects.toThrow('reference')
  await rm(asset); await symlink(join(directory, 'SOUL.md'), asset)
  await expect(service.readAvatar(workspace, topic.id, ref, directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(topic.id))))).rejects.toThrow()
  await expect(service.saveAvatar(workspace, topic.id, imageInput(), directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(topic.id))))).rejects.toThrow()
  await rm(join(directory, '.agentmux', 'avatars'), { recursive: true })
  const outside = await mkdtemp(join(tmpdir(), 'mote-avatar-outside-')); roots.push(outside)
  await symlink(outside, join(directory, '.agentmux', 'avatars'))
  await expect(service.saveAvatar(workspace, topic.id, imageInput(), directoryIdentity(workspace.hostId, join(workspace.path, scratchTopicDirectoryName(topic.id))))).rejects.toThrow()
  expect(await readdir(outside)).toEqual([])
})
it('old editor locator cannot write or read a replacement directory or host with the same workspace and topic ids', async () => {
  const { workspace, service, topic } = await fixture()
  const key = directoryIdentity(workspace.hostId, join(workspace.path, topic.directoryPath))
  const replacementPath = await mkdtemp(join(tmpdir(), 'mote-avatar-replacement-')); roots.push(replacementPath)
  const replacement = { ...workspace, path: replacementPath }
  const next = await service.ensureMote(replacement, topic.id)
  await expect(service.saveAvatar(replacement, topic.id, imageInput(), key)).rejects.toThrow('changed')
  await expect(service.previewAvatar(replacement, topic.id, imageInput(), key)).rejects.toThrow('changed')
  await expect(service.saveAvatar({ ...workspace, hostId: 'other' }, topic.id, imageInput(), key)).rejects.toThrow('changed')
  expect(await readdir(join(replacementPath, next.directoryPath, '.agentmux'))).not.toContain('avatars')
})

it('explicit custom avatar preview, save and read do not consume unrelated Wiki or collaborator directory contents', async () => {
  const { workspace, service } = await fixture()
  const topic = await service.ensureMote(workspace, 'view:local-avatar')
  const directory = join(workspace.path, topic.directoryPath), key = directoryIdentity(workspace.hostId, directory)
  const ref = await service.saveAvatar(workspace, topic.id, imageInput(), key)
  const expected = await service.readAvatar(workspace, topic.id, ref, key)
  await rm(join(directory, SCRATCH_TOPIC_WIKI_PATH)); await mkdir(join(directory, SCRATCH_TOPIC_WIKI_PATH))
  await expect(service.read(workspace, topic.id)).rejects.toThrow()
  await expect(service.previewAvatar(workspace, topic.id, imageInput(), key)).resolves.toEqual(expected)
  await expect(service.readAvatar(workspace, topic.id, ref, key)).resolves.toEqual(expected)
  await expect(service.saveAvatar(workspace, topic.id, imageInput(), key)).resolves.toEqual(ref)
  await rm(join(directory, '.agents'), { recursive: true })
  await expect(service.read(workspace, topic.id)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(service.previewAvatar(workspace, topic.id, imageInput(), key)).resolves.toEqual(expected)
  await expect(service.readAvatar(workspace, topic.id, ref, key)).resolves.toEqual(expected)
  await expect(service.saveAvatar(workspace, topic.id, imageInput(), key)).resolves.toEqual(ref)
})
