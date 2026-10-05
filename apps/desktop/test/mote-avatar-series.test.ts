const { fixturePath: _reshape_fixturePath } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { mkdtemp, mkdir, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_MOTE_FACE } from '@agentmux/core/mote-face'
import { parseMoteAvatarSeriesResult, type MoteAvatarSeriesDefinition, type MoteAvatarSeriesLocator } from '@agentmux/core/mote-avatar-series'
import { rpcEncode, AGENTMUX_RPC_MAX_MESSAGE_BYTES } from '../../../packages/core/src/public-rpc-frame'
import { MoteAvatarSeriesOwner } from '../src/main/mote-avatar-series'
import { controlledNativeImage, imagePng } from './fixtures/mote-identity-image'

const hashes = vi.hoisted(() => vi.fn())
vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof import('node:crypto')>()
  return { ...original, createHash: (...args: Parameters<typeof original.createHash>) => { hashes(); return original.createHash(...args) } }
})
const roots: string[] = []
afterEach(async () => { hashes.mockClear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-avatar-series-'))); roots.push(root)
  const userRoot = join(root, 'user'), builtinRoot = join(root, 'builtin')
  await Promise.all([mkdir(userRoot), mkdir(builtinRoot)])
  const decode = vi.fn(controlledNativeImage), owner = new MoteAvatarSeriesOwner({ userRoot, builtinRoot }, decode)
  return { root, userRoot, builtinRoot, decode, owner }
}
async function series(root: string, name = 'geometry') { const path = join(root, name); await mkdir(path); return path }
const locator = (entryId: string, origin: MoteAvatarSeriesLocator['origin'] = 'user', seriesId = 'geometry'): MoteAvatarSeriesLocator => ({ origin, seriesId, entryId })
async function declaration(path: string, entries: unknown[], title = 'Geometry') {
  await writeFile(join(path, 'series.json'), JSON.stringify({ schema: 'agentmux.avatar-series.v1', title, entries }))
}
function glb(change?: (value: Record<string, any>) => void, binaryBytes = Buffer.alloc(72)): Buffer {
  const data: Record<string, any> = {
    asset: { version: '2.0' }, buffers: [{ byteLength: 72 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }],
    materials: [{}], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0, targets: [{ POSITION: 1 }] }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
  }
  change?.(data)
  const text = Buffer.from(JSON.stringify(data)), json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32); text.copy(json)
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8), binary = Buffer.alloc(Math.ceil(binaryBytes.length / 4) * 4)
  binaryBytes.copy(binary)
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8)
  jsonHeader.writeUInt32LE(json.length); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, json, binHeader, binary])
}
function texturedGlb(images: Buffer[], textures = images.map((_, source) => ({ source }))): Buffer {
  const binary = Buffer.concat([Buffer.alloc(72), ...images])
  return glb(data => {
    data.buffers[0].byteLength = binary.length
    let offset = 72
    data.images = images.map(bytes => {
      const index = data.bufferViews.length
      data.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length })
      offset += bytes.length
      return { bufferView: index, mimeType: 'image/png' }
    })
    data.textures = textures
  }, binary)
}
const glbDefinition: MoteAvatarSeriesDefinition = {
  kind: 'glb', file: 'model.glb', materials: [{ index: 0, role: 'shell' }],
  morphs: [{ id: 'curve', label: 'Curve', meshIndex: 0, targetIndex: 0 }], framing: { nodeIndex: 0 }
}

it('lists real ordinary series metadata without decoding or hashing their asset bytes or imposing a cumulative catalog cutoff', async () => {
  const { userRoot, builtinRoot, owner, decode } = await fixture()
  for (const root of [builtinRoot, userRoot]) {
    const path = await series(root)
    await writeFile(join(path, 'ordinary.png'), Buffer.from('not decoded during list'))
    await writeFile(join(path, 'photo.JPEG'), Buffer.from('not decoded during list'))
  }
  for (let index = 0; index < 40; index++) {
    const path = await series(userRoot, 'series-' + index)
    await writeFile(join(path, 'entry.jpg'), Buffer.from('metadata only'))
  }
  hashes.mockClear()
  const catalog = await owner.list()
  expect(catalog.roots.map(root => root.state)).toEqual(['available', 'available'])
  expect(catalog.series).toHaveLength(42)
  expect(catalog.series.filter(series => series.seriesId === 'geometry').map(series => series.origin)).toEqual(['builtin', 'user'])
  expect(catalog.series.find(series => series.origin === 'user' && series.seriesId === 'geometry')!.entries.map(entry => entry.entryId)).toEqual(['ordinary.png', 'photo.JPEG'])
  expect(catalog.issues).toEqual([])
  expect(decode).not.toHaveBeenCalled(); expect(hashes).not.toHaveBeenCalled()
  expect(parseMoteAvatarSeriesResult('space.mote.avatar.list', catalog, {})).toEqual(catalog)
})

it('keeps ordinary images beside actual face2d/GLB declarations and local invalid entries, deduplicating only their exact named image files', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  await writeFile(join(path, 'selected.png'), imagePng()); await writeFile(join(path, 'other.png'), imagePng())
  await declaration(path, [
    { id: 'portrait', title: 'Portrait', definition: { kind: 'image', file: 'selected.png' } },
    { id: 'calm', title: 'Calm', definition: { kind: 'face2d', face: DEFAULT_MOTE_FACE } },
    { id: 'model', title: 'Native model', definition: glbDefinition },
    { id: 'bad', title: 'Unsupported', definition: { kind: 'script', file: 'run.js' } },
    { id: 'other.png', title: 'Conflicting face', definition: { kind: 'face2d', face: DEFAULT_MOTE_FACE } }
  ])
  const catalog = await owner.list(), entries = catalog.series[0]!.entries
  expect(entries.map(entry => entry.entryId)).toEqual(['portrait', 'calm', 'model', 'other.png'])
  expect(entries[1]!.definition).toEqual({ kind: 'face2d', face: DEFAULT_MOTE_FACE })
  expect(catalog.issues).toHaveLength(2)
  expect(catalog.issues[0]!.source).toEqual(locator('bad'))
  expect(catalog.issues[1]!.code).toBe('AVATAR_ENTRY_CONFLICT')
})

it('keeps a good ordinary image when another same-series filename cannot form a supported definition', async () => {
  const { userRoot, owner, decode } = await fixture(), path = await series(userRoot)
  await writeFile(join(path, 'good.png'), imagePng())
  await writeFile(join(path, 'odd:name.png'), imagePng())
  const catalog = await owner.list()
  expect(catalog.series).toHaveLength(1)
  expect(catalog.series[0]!.entries.map(entry => entry.entryId)).toEqual(['good.png'])
  expect(catalog.issues).toHaveLength(1)
  expect(catalog.issues[0]!.message).toContain(join(path, 'odd:name.png'))
  expect(catalog.issues[0]!.recovery).toBeTruthy()
  expect(decode).not.toHaveBeenCalled()
  expect((await owner.preview({ source: locator('good.png') })).payload.kind).toBe('image')
})

it('preserves readable pictures when a declaration is malformed or repeats an ambiguous exact entry id', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  await writeFile(join(path, 'picture.png'), imagePng())
  await writeFile(join(path, 'series.json'), '{\ninvalid\n')
  const partial = await owner.list()
  expect(partial.series).toHaveLength(1)
  expect(partial.series[0]!.entries.map(entry => entry.entryId)).toEqual(['picture.png'])
  expect(partial.issues.length).toBeGreaterThan(0)
  expect(partial.issues[0]!.message).not.toMatch(/[\r\n]/u)
  expect(partial.issues[0]!.message).toContain(join(path, 'series.json'))
  expect(partial.issues[0]!.source).toBeUndefined()
  await declaration(path, [
    { id: 'same', title: 'A', definition: { kind: 'face2d', face: DEFAULT_MOTE_FACE } },
    { id: 'same', title: 'B', definition: { kind: 'image', file: 'picture.png' } }
  ])
  const repeated = await owner.list()
  expect(repeated.series[0]!.entries.map(entry => entry.entryId)).toEqual(['picture.png'])
  expect(repeated.issues.some(issue => issue.code === 'AVATAR_ENTRY_CONFLICT')).toBe(true)
})

it('aggregates 200000 invalid declaration rows without losing the original valid face or exceeding the production RPC frame', async () => {
  const { userRoot, owner, decode } = await fixture(), path = await series(userRoot)
  const invalidRows = 200000
  await declaration(path, [
    ...Array.from({ length: invalidRows }, () => null),
    { id: 'good', title: 'Original face', definition: { kind: 'face2d', face: DEFAULT_MOTE_FACE } }
  ])
  const bytes = await readFile(join(path, 'series.json'))
  expect(bytes.length).toBeLessThan(8 * 1024 * 1024)
  const catalog = await owner.list()
  const prepared = await owner.preview({ source: locator('good') })
  // The real transport oracle comes first: unaggregated diagnostics must reproduce its budget failure.
  for (const result of [catalog, prepared]) {
    const frame = rpcEncode({ jsonrpc: '2.0', id: 'metadata-amplification', result })
    expect(Buffer.byteLength(frame)).toBeLessThan(AGENTMUX_RPC_MAX_MESSAGE_BYTES)
    expect(JSON.parse(frame).result).toEqual(result)
  }
  expect(catalog.series).toHaveLength(1)
  expect(catalog.series[0]!.entries.map(entry => entry.entryId)).toEqual(['good'])
  expect(catalog.issues).toHaveLength(1)
  expect(catalog.issues[0]).toMatchObject({ code: 'AVATAR_DEFINITION_INVALID', count: invalidRows })
  expect(catalog.issues[0]!.source).toBeUndefined()
  expect(catalog.issues[0]!.message).toContain(path)
  expect(catalog.issues[0]!.message).toContain(String(invalidRows))
  expect(prepared.payload).toEqual({ kind: 'face2d', face: DEFAULT_MOTE_FACE })
  expect(prepared.issues).toEqual(catalog.issues)
  expect(decode).not.toHaveBeenCalled()
}, 20000)

it('summarizes many distinct invalid entry identities with exact counts and limited actual examples while retaining every valid entry', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  const invalidRows = 20000
  const entries = Array.from({ length: invalidRows }, (_, index) => ({
    id: 'bad-' + index, title: 'Unsupported original entry', definition: { kind: 'script' }
  }))
  const valid = Array.from({ length: 1500 }, (_, index) => ({
    id: 'face-' + index, title: 'Original face ' + index, definition: { kind: 'face2d' as const, face: DEFAULT_MOTE_FACE }
  }))
  await declaration(path, [...entries, ...valid])
  const catalog = await owner.list()
  expect(catalog.series[0]!.entries.map(entry => entry.entryId)).toEqual(valid.map(entry => entry.id))
  expect(catalog.issues).toHaveLength(1)
  expect(catalog.issues[0]!.count).toBe(invalidRows)
  expect(catalog.issues[0]!.source).toBeUndefined()
  for (const index of [0, 1, 2]) expect(catalog.issues[0]!.message).toContain('bad-' + index + ':')
  expect(catalog.issues[0]!.message).not.toContain('bad-3:')
  const prepared = await owner.preview({ source: locator('face-1499') })
  expect(prepared.payload).toEqual({ kind: 'face2d', face: DEFAULT_MOTE_FACE })
  expect(prepared.issues).toHaveLength(1)
  expect(prepared.issues[0]!.count).toBe(invalidRows)
  expect(() => rpcEncode({ jsonrpc: '2.0', id: 'unique-bad-entries', result: prepared })).not.toThrow()
})

it('does not attach a distinct sibling entry failure to a usable original preview', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  await declaration(path, [
    { id: 'good', title: 'Original face', definition: { kind: 'face2d', face: DEFAULT_MOTE_FACE } },
    { id: 'bad-sibling', title: 'Broken sibling', definition: { kind: 'script' } }
  ])
  const catalog = await owner.list()
  expect(catalog.issues[0]!.source).toEqual(locator('bad-sibling'))
  expect((await owner.preview({ source: locator('good') })).issues).toEqual([])
})

it('reports unavailable and missing roots independently without hiding another original source', async () => {
  const { userRoot, builtinRoot, owner } = await fixture(), path = await series(userRoot)
  await writeFile(join(path, 'good.png'), imagePng())
  await rm(builtinRoot, { recursive: true }); await writeFile(builtinRoot, 'not a directory')
  const partial = await owner.list()
  expect(partial.roots.map(root => root.state)).toEqual(['unavailable', 'available'])
  expect(partial.series[0]!.entries[0]!.entryId).toBe('good.png')
  expect(partial.issues[0]!.message).toContain(builtinRoot)
  await rm(builtinRoot)
  expect((await owner.list()).roots.map(root => root.state)).toEqual(['missing', 'available'])
})

it('reads one exact image through the original decoder with origin isolation, actual bytes revision and native decode failures', async () => {
  const { userRoot, builtinRoot, owner, decode } = await fixture()
  const user = await series(userRoot), builtin = await series(builtinRoot)
  await writeFile(join(user, 'face.png'), imagePng(256, 256, [200, 1, 1]))
  await writeFile(join(builtin, 'face.png'), imagePng(256, 256, [1, 1, 200]))
  const first = await owner.preview({ source: locator('face.png') })
  expect(first.payload).toMatchObject({ kind: 'image', image: { width: 256, height: 256 } })
  expect(decode).toHaveBeenCalledTimes(1)
  const other = await owner.preview({ source: locator('face.png', 'builtin') })
  expect(first.source.revision).not.toBe(other.source.revision)
  await expect(owner.preview({ source: locator('face.png'), expectedRevision: first.source.revision })).resolves.toEqual(first)
  await writeFile(join(user, 'face.png'), imagePng(256, 256, [1, 200, 1]))
  const beforeConflict = decode.mock.calls.length
  const conflict = await owner.preview({ source: locator('face.png'), expectedRevision: first.source.revision }).catch(error => error)
  expect(decode).toHaveBeenCalledTimes(beforeConflict)
  expect(conflict).toMatchObject({ code: 'AVATAR_SOURCE_REVISION_CONFLICT' })
  const failed = new MoteAvatarSeriesOwner({ userRoot, builtinRoot }, () => ({ isEmpty: () => true }) as never)
  await expect(failed.preview({ source: locator('face.png') })).rejects.toThrow('decoded')
})

it('uses only the exact series and retains local declaration issues during an otherwise usable image preparation', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  await writeFile(join(path, 'good.png'), imagePng())
  await writeFile(join(path, 'series.json'), 'bad declaration')
  await symlink(_reshape_fixturePath("not-an-original-source"), join(userRoot, 'unrelated'))
  const prepared = await owner.preview({ source: locator('good.png') })
  expect(prepared.payload.kind).toBe('image')
  expect(prepared.issues.length).toBeGreaterThan(0)
  expect(prepared.issues.every(issue => issue.code !== 'AVATAR_SOURCE_LINK')).toBe(true)
})

it('prepares original editable face parameters and hashes canonical definition, while display title changes do not grant a different source', async () => {
  const { userRoot, owner, decode } = await fixture(), path = await series(userRoot)
  await declaration(path, [{ id: 'face', title: 'One', definition: { kind: 'face2d', face: DEFAULT_MOTE_FACE } }])
  const first = await owner.preview({ source: locator('face') })
  expect(first.payload).toEqual({ kind: 'face2d', face: DEFAULT_MOTE_FACE })
  await declaration(path, [{ id: 'face', title: 'Renamed', definition: { face: { ...DEFAULT_MOTE_FACE }, kind: 'face2d' } }], 'Renamed series')
  expect((await owner.preview({ source: locator('face') })).source.revision).toBe(first.source.revision)
  await declaration(path, [{ id: 'face', title: 'Renamed', definition: { kind: 'face2d', face: { ...DEFAULT_MOTE_FACE, eyes: 'calm' } } }])
  expect((await owner.preview({ source: locator('face') })).source.revision).not.toBe(first.source.revision)
  expect(decode).not.toHaveBeenCalled()
})

it('refuses paths and links outside original roots while preserving remaining ordinary entries', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  await writeFile(join(path, 'good.png'), imagePng())
  const outside = await series(userRoot, 'outside'); await writeFile(join(outside, 'secret.png'), imagePng())
  await symlink(join(outside, 'secret.png'), join(path, 'linked.png'))
  await symlink(outside, join(path, 'nested'))
  await declaration(path, [
    { id: 'traversal', title: 'Wrong', definition: { kind: 'image', file: '../outside/secret.png' } },
    { id: 'linked', title: 'Linked', definition: { kind: 'image', file: 'nested/secret.png' } },
    { id: 'linked-file', title: 'Linked file', definition: { kind: 'image', file: 'linked.png' } }
  ])
  const catalog = await owner.list()
  expect(catalog.series.find(series => series.seriesId === 'geometry')!.entries.some(entry => entry.entryId === 'good.png')).toBe(true)
  expect(catalog.issues.length).toBeGreaterThan(0)
  await expect(owner.preview({ source: locator('linked') })).rejects.toMatchObject({ code: 'AVATAR_DIRECTORY_INVALID' })
  await expect(owner.preview({ source: locator('linked-file') })).rejects.toThrow()
  await expect(owner.preview({ source: locator('../outside') })).rejects.toThrow()
  await expect(owner.preview({ source: { origin: 'user', seriesId: '..', entryId: 'secret.png' } })).rejects.toThrow()
})

it('prepares actual self-contained GLB bytes and native machine indices without reading image data or inventing render completion', async () => {
  const { userRoot, owner, decode } = await fixture(), path = await series(userRoot)
  const bytes = glb(); await writeFile(join(path, 'model.glb'), bytes)
  await declaration(path, [{ id: 'model', title: 'Native', definition: glbDefinition }])
  const prepared = await owner.preview({ source: locator('model') })
  expect(prepared.payload).toEqual({ kind: 'glb', dataBase64: bytes.toString('base64') })
  expect(prepared.definition).toEqual(glbDefinition)
  expect(prepared).not.toHaveProperty('rendered')
  expect(decode).not.toHaveBeenCalled()
})

it('reads the packaged mature GLB through the same owner and confirms its declared original morph/material/framing references', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  const model = await readFile(new URL('../resources/avatar-series/geometry/RobotExpressive.glb', import.meta.url))
  const manifest = JSON.parse(await readFile(new URL('../resources/avatar-series/geometry/series.json', import.meta.url), 'utf8'))
  await writeFile(join(path, 'RobotExpressive.glb'), model)
  await writeFile(join(path, 'series.json'), JSON.stringify(manifest))
  const entries = (await owner.list()).series[0]!.entries.filter(entry => entry.definition.kind === 'glb')
  expect(entries.length).toBeGreaterThan(0)
  for (const entry of entries) {
    const prepared = await owner.preview({ source: locator(entry.entryId) })
    expect(prepared.payload).toEqual({ kind: 'glb', dataBase64: model.toString('base64') })
    expect(prepared.definition).toEqual(entry.definition)
  }
})

it('validates only the selected GLB actual embedded image slices through the original decoder', async () => {
  const { userRoot, owner, decode } = await fixture(), path = await series(userRoot)
  const png = imagePng(128, 64), bytes = texturedGlb([png])
  await writeFile(join(path, 'model.glb'), bytes)
  await declaration(path, [{ id: 'model', title: 'Native', definition: glbDefinition }])
  await owner.list()
  expect(decode).not.toHaveBeenCalled()
  const prepared = await owner.preview({ source: locator('model') })
  expect(prepared.payload).toEqual({ kind: 'glb', dataBase64: bytes.toString('base64') })
  expect(decode).toHaveBeenCalledTimes(1)
  expect(decode.mock.calls[0]![0]).toEqual(png)
})

it('rejects malicious encoded GLB image dimensions before native decoding while other pictures remain usable', async () => {
  const { userRoot, owner, decode } = await fixture(), path = await series(userRoot)
  const png = imagePng(); png.writeUInt32BE(4097, 16)
  await writeFile(join(path, 'model.glb'), texturedGlb([png]))
  await writeFile(join(path, 'good.png'), imagePng())
  await declaration(path, [{ id: 'model', title: 'Native', definition: glbDefinition }])
  await expect(owner.preview({ source: locator('model') })).rejects.toThrow('4096')
  expect(decode).not.toHaveBeenCalled()
  expect((await owner.preview({ source: locator('good.png') })).payload.kind).toBe('image')
})

it('bounds selected model decoded embedded images including unused images and all declared texture slots', async () => {
  const { userRoot, owner, decode } = await fixture(), path = await series(userRoot)
  const large = imagePng(3072, 3072)
  await declaration(path, [{ id: 'model', title: 'Native', definition: glbDefinition }])
  // Each original image is individually allowed; two together exceed this model's 16MP.
  await writeFile(join(path, 'model.glb'), texturedGlb([large, large], []))
  await expect(owner.preview({ source: locator('model') })).rejects.toMatchObject({ code: 'AVATAR_GLB_TEXTURE_LIMIT' })
  expect(decode).toHaveBeenCalledTimes(2)
  decode.mockClear()
  // One embedded image may supply several distinct sampler/texture slots.
  await writeFile(join(path, 'model.glb'), texturedGlb([large], [{ source: 0 }, { source: 0 }]))
  await expect(owner.preview({ source: locator('model') })).rejects.toMatchObject({ code: 'AVATAR_GLB_TEXTURE_LIMIT' })
  expect(decode).toHaveBeenCalledTimes(1)
  await writeFile(join(path, 'model.glb'), texturedGlb([imagePng()], [{ source: 4 }]))
  await expect(owner.preview({ source: locator('model') })).rejects.toMatchObject({ code: 'AVATAR_GLB_INVALID' })
})

it.each([
  ['external buffer', (data: Record<string, any>) => { data.buffers[0].uri = 'https://example.invalid/model.bin' }, 'AVATAR_GLB_EXTERNAL_RESOURCE'],
  ['external image', (data: Record<string, any>) => { data.images = [{ uri: 'image.png' }] }, 'AVATAR_GLB_EXTERNAL_RESOURCE'],
  ['unsupported decoder', (data: Record<string, any>) => { data.extensionsRequired = ['KHR_draco_mesh_compression'] }, 'AVATAR_GLB_UNSUPPORTED'],
  ['missing morph', (data: Record<string, any>) => { data.meshes[0].primitives[0].targets = [] }, 'AVATAR_GLB_INVALID'],
  ['missing morph buffer', (data: Record<string, any>) => { data.accessors[1].bufferView = 10 }, 'AVATAR_GLB_INVALID'],
  ['invalid view bounds', (data: Record<string, any>) => { data.bufferViews[1].byteLength = 200 }, 'AVATAR_GLB_INVALID'],
  ['geometry count mismatch', (data: Record<string, any>) => { data.accessors[1].count = 2 }, 'AVATAR_GLB_INVALID']
])('refuses %s in this exact GLB without hiding other source metadata', async (_name, change, code) => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  await writeFile(join(path, 'model.glb'), glb(change)); await writeFile(join(path, 'good.png'), imagePng())
  await declaration(path, [{ id: 'model', title: 'Native', definition: glbDefinition }])
  await expect(owner.preview({ source: locator('model') })).rejects.toMatchObject({ code })
  expect((await owner.preview({ source: locator('good.png') })).payload.kind).toBe('image')
})

it('rejects malformed container lengths and one oversized model without imposing a library-wide budget', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  await declaration(path, [{ id: 'model', title: 'Native', definition: glbDefinition }])
  await writeFile(join(path, 'good.png'), imagePng())
  const bytes = glb(); bytes.writeUInt32LE(bytes.length - 1, 8)
  await writeFile(join(path, 'model.glb'), bytes)
  await expect(owner.preview({ source: locator('model') })).rejects.toMatchObject({ code: 'AVATAR_GLB_INVALID' })
  const handle = await open(join(path, 'model.glb'), 'w')
  try { await handle.truncate(32 * 1024 * 1024 + 1) } finally { await handle.close() }
  expect((await owner.list()).series[0]!.entries.map(entry => entry.entryId)).toEqual(['model', 'good.png'])
  await expect(owner.preview({ source: locator('model') })).rejects.toMatchObject({ code: 'AVATAR_SOURCE_INPUT_LIMIT' })
  expect((await owner.preview({ source: locator('good.png') })).payload.kind).toBe('image')
})

it('refuses missing declared material, mesh and framing indices from the actual selected GLB', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  await writeFile(join(path, 'model.glb'), glb())
  for (const definition of [
    { ...glbDefinition, materials: [{ index: 20, role: 'shell' }] },
    { ...glbDefinition, morphs: [{ id: 'curve', label: 'Curve', meshIndex: 20, targetIndex: 0 }] },
    { ...glbDefinition, framing: { nodeIndex: 20 } }
  ]) {
    await declaration(path, [{ id: 'model', title: 'Native', definition }])
    await expect(owner.preview({ source: locator('model') })).rejects.toMatchObject({ code: 'AVATAR_GLB_INVALID' })
  }
})

it('bounds one declaration parser input while keeping ordinary pictures and other legitimate series', async () => {
  const { userRoot, owner } = await fixture(), path = await series(userRoot)
  await writeFile(join(path, 'good.png'), imagePng())
  const handle = await open(join(path, 'series.json'), 'w')
  try { await handle.truncate(8 * 1024 * 1024 + 1) } finally { await handle.close() }
  const catalog = await owner.list()
  expect(catalog.series[0]!.entries.map(entry => entry.entryId)).toEqual(['good.png'])
  expect(catalog.issues.some(issue => issue.code === 'AVATAR_SOURCE_INPUT_LIMIT')).toBe(true)
  expect((await owner.preview({ source: locator('good.png') })).payload.kind).toBe('image')
})
