// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directoryIdentity } from '@agentmux/host/mote-model'
import { webcrypto } from 'node:crypto'
import { createClientUiRoot } from './helpers/client-ui-render'
import { SpaceIconPicker } from '../src/renderer/src/components/SpaceIconPicker'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { ConfigOwner } from '../src/main/config-owner'
import { SpaceObjectImages } from '../src/main/space-object-images'
import { SpaceObjectAvatarOwner } from '../src/main/space-object-avatar'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { controlledNativeImage, imageInput } from './fixtures/mote-identity-image'
import type { SpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import type { ObjectAvatarAssetRequest } from '../src/shared/object-avatar-request'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => '/private-avatar-gui' }, nativeTheme: { shouldUseDarkColors: true }, nativeImage: { createFromBuffer: (bytes: Buffer) => controlledNativeImage(bytes) } }))
let directory: string, root: ReturnType<typeof createClientUiRoot>, container: HTMLDivElement
const initial = useAppStore.getState()
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('crypto', webcrypto)
  directory = await mkdtemp(join(tmpdir(), 'avatar-gui-'))
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true); await rm(directory, { recursive: true, force: true }) })
async function fixture() {
  const content = join(directory, 'original-category'); await mkdir(content)
  const objectKey = directoryIdentity('local', content)
  const target: SpaceIconTarget = { kind: 'category', key: objectKey, name: 'Original Category', imageTarget: { kind: 'category', categoryId: 'original-category', objectKey } }
  const store = new ConfigStore(join(directory, 'config.json')); let config = await store.save(structuredClone(DEFAULT_CONFIG))
  const configOwner = new ConfigOwner({ read: () => config, save: value => store.save(value), publish: value => { config = value } })
  const images = new SpaceObjectImages(async () => ({ hostId: 'local', directoryPath: content }), controlledNativeImage)
  const owner = new SpaceObjectAvatarOwner(configOwner, store, images, async value => { if (value.objectKey !== target.key) throw new Error('Wrong original object'); return { hostId: 'local', directoryPath: content } })
  const users = new WorkbenchUserStateStore(join(directory, 'workbench.json'))
  const context = { actor: { kind: 'user' as const, id: 'trusted-private-gui' }, async assertCurrent() {} }
  const calls = vi.spyOn(api.objectAvatars, 'call').mockImplementation((method, value) => owner.call(method, value, context))
  vi.spyOn(api.config, 'get').mockImplementation(async () => structuredClone(config))
  vi.spyOn(api.ui, 'readObjectAvatarRequests').mockImplementation(value => users.readObjectAvatarRequests(value))
  vi.spyOn(api.ui, 'keepObjectAvatarRequest').mockImplementation(value => users.keepObjectAvatarRequest(value))
  vi.spyOn(api.ui, 'retireObjectAvatarRequest').mockImplementation(value => users.retireObjectAvatarRequest(value))
  useAppStore.setState({ config, spaceObjectIcons: {}, agentComposerDrafts: { retained: 'unsent original draft' } })
  const onClose = vi.fn()
  const mount = async (value = target) => { await act(async () => root.render(<SpaceIconPicker target={value} onClose={onClose} />)); await settle() }
  return { target, store, owner, configOwner, images, users, calls, onClose, mount, config: () => config }
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) }) }
function button(label: string) { const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label || value.getAttribute('aria-label') === label); expect(element, label).toBeDefined(); return element! }
async function click(label: string) { await act(async () => button(label).click()); await settle() }

it('the real Category picker saves one typed owner request and preserves the original draft while an owner failure is inspected without replay', async () => {
  const f = await fixture(); await f.mount()
  await click('Book icon')
  vi.spyOn(f.store, 'save').mockRejectedValueOnce(new Error('original save ACK unknown'))
  await click('Save avatar')
  expect(f.onClose).not.toHaveBeenCalled(); expect(button('Book icon').getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('[data-object-avatar-save-notice]')?.textContent).toContain('original save ACK unknown')
  const submissions = () => f.calls.mock.calls.filter(([method]) => method === 'space.object.avatar.save')
  expect(submissions()).toHaveLength(1); expect(submissions()[0]![1]).toMatchObject({ target: f.target.imageTarget, choice: 'book' })
  expect(submissions()[0]![1]).not.toHaveProperty('operationId')
  await click('Inspect save'); expect(submissions()).toHaveLength(1)
  await click('Save avatar')
  expect(f.onClose).toHaveBeenCalledTimes(1); expect(f.config().appearance.spaceObjectIcons?.[f.target.key]).toBe('book')
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ retained: 'unsent original draft' })
})

it('opening the actual picker inspects an exact kept PNG request; the user can choose a new icon without discarding or replaying the unknown original', async () => {
  const f = await fixture()
  const before = await f.owner.call('space.object.avatar.read', { target: f.target.imageTarget! }, { actor: { kind: 'user', id: 'trusted-private-gui' }, async assertCurrent() {} })
  const request: ObjectAvatarAssetRequest = { target: f.target.imageTarget!, operationId: 'unknown-kept-png', beforeRevision: before.revision, choice: { kind: 'png', dataUrl: imageInput().dataUrl } }
  await f.users.keepObjectAvatarRequest(request)
  await f.mount()
  expect(document.querySelector('[data-object-avatar-save-notice]')?.textContent).toContain(request.operationId)
  expect(button('Save avatar').disabled).toBe(true)
  expect(f.calls.mock.calls.some(([method]) => method === 'space.object.avatar.save')).toBe(false)
  vi.mocked(api.ui.readObjectAvatarRequests).mockResolvedValueOnce([])
  await click('Inspect save')
  expect(document.querySelector('[data-object-avatar-save-notice]')?.textContent).toContain(request.operationId)
  expect(api.ui.retireObjectAvatarRequest).not.toHaveBeenCalled()
  await click('Book icon'); await click('Save avatar')
  expect(f.onClose).toHaveBeenCalledTimes(1)
  expect((await f.users.readObjectAvatarRequests(request.target))[0]!.request).toEqual(request)
  expect(f.calls.mock.calls.filter(([method]) => method === 'space.object.avatar.save')).toHaveLength(1)
})

it('a late acknowledged save cannot close a replacement editor or replace its current draft', async () => {
  const f = await fixture(); await f.mount(); await click('Book icon')
  const original = f.owner.call.bind(f.owner); let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.calls.mockImplementation(async (method, value) => { const result = await original(method, value, { actor: { kind: 'user', id: 'trusted-private-gui' }, async assertCurrent() {} }); if (method === 'space.object.avatar.save') await gate; return result })
  await act(async () => button('Save avatar').click()); await settle()
  const other: SpaceIconTarget = { ...f.target, key: 'replacement-key', imageTarget: { kind: 'category', categoryId: 'replacement', objectKey: 'replacement-key' } }
  await f.mount(other); await click('Brain icon')
  await act(async () => release()); await settle()
  expect(f.onClose).not.toHaveBeenCalled(); expect(button('Brain icon').getAttribute('aria-pressed')).toBe('true')
})

it('an old configuration read after the acknowledged save cannot replace a later original owner publication', async () => {
  const f = await fixture(); await f.mount(); await click('Book icon')
  const unsubscribe = f.configOwner.subscribe(value => useAppStore.getState().setConfig(value))
  let release!: () => void, began!: () => void
  const waiting = new Promise<void>(resolve => { began = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.config.get).mockImplementationOnce(async () => { const captured = structuredClone(f.config()); began(); await gate; return captured })
  try {
    await act(async () => button('Save avatar').click()); await waiting
    await act(async () => { await f.configOwner.update(value => ({ ...value, appearance: { ...value.appearance, spaceObjectIcons: { ...value.appearance.spaceObjectIcons, [f.target.key]: 'brain' } } })) })
    expect(useAppStore.getState().spaceObjectIcons[f.target.key]).toBe('brain')
    await act(async () => release()); await settle()
    expect(f.onClose).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().spaceObjectIcons[f.target.key]).toBe('brain')
    expect(useAppStore.getState().agentComposerDrafts).toEqual({ retained: 'unsent original draft' })
  } finally { release(); unsubscribe() }
})


it('a historical publication by another actual actor cannot confirm or retire this GUI pending request with the same exact operation and body', async () => {
  const f = await fixture(), actor = { actor: { kind: 'user' as const, id: 'another-trusted-owner-user' }, async assertCurrent() {} }
  const before = await f.owner.call('space.object.avatar.read', { target: f.target.imageTarget! }, actor)
  const request: ObjectAvatarAssetRequest = { target: f.target.imageTarget!, operationId: 'copied-exact-publication', beforeRevision: before.revision, choice: { kind: 'png', dataUrl: imageInput().dataUrl } }
  const published = await f.owner.call('space.object.avatar.save', request, actor)
  expect(published.state).toBe('saved')
  await f.users.keepObjectAvatarRequest(request)
  await f.mount()
  const inspect = f.calls.mock.calls.findIndex(([method, value]) => method === 'space.object.avatar.read' && value.operationId === request.operationId)
  expect(inspect).toBeGreaterThanOrEqual(0)
  const result = await f.calls.mock.results[inspect]!.value
  expect(result).toMatchObject({ readerIdentity: { id: 'trusted-private-gui' }, operation: { actor: { id: 'another-trusted-owner-user' } } })
  for (let index = 0; index < 50 && !document.querySelector('[data-object-avatar-save-notice]'); index++) await settle()
  expect(await f.users.readObjectAvatarRequests(request.target)).toHaveLength(1)
  expect(api.ui.retireObjectAvatarRequest).not.toHaveBeenCalled()
  expect(document.querySelector('[data-object-avatar-save-notice]')?.textContent).toContain(request.operationId)
})

it('the original Mote GUI receipt predicate requires the authenticated reader and exact original body, with unavailable legacy attribution retained', async () => {
  const { moteAvatarSaveMatches, moteAvatarSaveRequestHash } = await import('../src/renderer/src/lib/mote-avatar-save-draft')
  const target = { workspaceId: '__scratch__', topicId: 'view:original', objectKey: directoryIdentity('local', join(directory, 'original-mote')) }
  const request = { target, operationId: 'original-mote-request', beforeRevision: 'sha256:' + '0'.repeat(64), source: { origin: 'user' as const, seriesId: 'original', entryId: 'image.png', revision: 'sha256:' + '1'.repeat(64) }, definition: { kind: 'image' as const, file: 'image.png' }, parameters: { kind: 'image' as const, zoom: 1, offsetX: 0, offsetY: 0 }, pngDataUrl: imageInput().dataUrl }
  const actor = { kind: 'agent' as const, id: 'original-agent', hostId: 'local', runtimeId: 'original-runtime', runId: 'original-ended-run' }
  const read = { target, revision: request.beforeRevision, choice: null, issues: [], readerIdentity: { kind: 'agent' as const, id: actor.id, hostId: actor.hostId, runtimeId: actor.runtimeId }, operation: { operationId: request.operationId, phase: 'published' as const, durability: 'confirmed' as const, actor, requestHash: await moteAvatarSaveRequestHash(request, actor) } }
  expect(await moteAvatarSaveMatches(request, read)).toBe(true)
  expect(await moteAvatarSaveMatches(request, { ...read, readerIdentity: { ...read.readerIdentity, id: 'another-authenticated-agent' } })).toBe(false)
  const { readerIdentity: _reader, ...unattributedRead } = read
  expect(await moteAvatarSaveMatches(request, unattributedRead)).toBe(false)
  const { actor: _actor, ...legacyOperation } = read.operation
  expect(await moteAvatarSaveMatches(request, { ...read, operation: legacyOperation })).toBe(false)
  expect(await moteAvatarSaveMatches(request, { ...read, target: { ...target, topicId: 'replacement' } })).toBe(false)
  expect(await moteAvatarSaveMatches({ ...request, parameters: { ...request.parameters, zoom: 2 } }, read)).toBe(false)
})
