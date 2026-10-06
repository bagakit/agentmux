import { constants, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { nativeImage, type NativeImage } from 'electron'
import {
  avatarSeriesCanonical, parseMoteAvatarSeriesDefinition, parseMoteAvatarSeriesLocator,
  parseMoteAvatarSeriesParams, parseMoteAvatarSeriesResult,
  type MoteAvatarSeriesCatalog, type MoteAvatarSeriesDefinition, type MoteAvatarSeriesIssue,
  type MoteAvatarSeriesLocator, type MoteAvatarSeriesPrepared, type MoteAvatarSeriesPreviewParams,
  type MoteAvatarSeriesCreateParams, type MoteAvatarSeriesCreateResult, type MoteAvatarSeriesRevealParams
} from '@agentmux/core/mote-avatar-series'
import { DEFAULT_MOTE_FACE } from '@agentmux/core/mote-face'
import { AVATAR_INPUT_MAX_BYTES, AVATAR_MAX_PIXELS } from '../shared/object-avatars.js'
import { decodeObjectAvatar, previewObjectAvatar } from './object-avatar-image.js'

// Individual parser inputs, not a cumulative library or consumer budget.
const GLB_MAX_BYTES = 32 * 1024 * 1024
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024
const IMAGE_FILE = /\.(png|jpe?g)$/iu
type Series = MoteAvatarSeriesCatalog['series'][number]
type Origin = MoteAvatarSeriesLocator['origin']
type NativeObject = Record<string, unknown>
const sourceError = (code: string, message: string): Error => Object.assign(new Error(message), { code })
function fail(message: string): never { throw sourceError('AVATAR_GLB_INVALID', message) }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
function object(value: unknown): NativeObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('The original GLB metadata is invalid.')
  return value as NativeObject
}
function items(value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('The original GLB collection is invalid.')
  return value
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('The original GLB index or length is invalid.')
  return value as number
}
function at(values: unknown[], index: unknown): NativeObject {
  const n = number(index)
  if (n >= values.length) fail('A declared native artwork index does not exist in the original GLB.')
  return object(values[n])
}
function title(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/u.test(value)
}
function issue(error: unknown, source?: MoteAvatarSeriesLocator, path?: string): MoteAvatarSeriesIssue {
  const cause = error as { code?: unknown; message?: unknown }
  return {
    code: typeof cause?.code === 'string' ? cause.code : 'AVATAR_SOURCE_UNAVAILABLE',
    message: ((path ? path + ': ' : '') + String(cause?.message ?? error)).replace(/[\0\r\n]/gu, ' ').slice(0, 2048),
    ...(source ? { source } : {}),
    recovery: 'Restore this exact original source or correct its declaration, then read it again. Other artwork and saved avatars remain available.'
  }
}

async function directory(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw sourceError('AVATAR_DIRECTORY_INVALID', 'The original avatar source is not a regular directory.')
  return await realpath(path)
}
/** Only a missing original Host directory is made; linked ancestors are never followed. */
async function ensureUserDirectory(path: string): Promise<string> {
  try {
    const actual = await directory(path)
    if (actual !== resolve(path)) throw sourceError('AVATAR_SOURCE_LINK', 'The original user avatar directory has a linked ancestor. Existing series are retained.')
    return actual
  } catch (error) {
    if (!missing(error)) throw error
  }
  await ensureUserDirectory(dirname(path))
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const actual = await directory(path)
  if (actual !== resolve(path)) throw sourceError('AVATAR_SOURCE_LINK', 'The user avatar directory changed during creation. Original content is retained.')
  return actual
}
async function filePath(series: string, file: string): Promise<string> {
  let parent = series
  const parts = file.split('/')
  for (const part of parts.slice(0, -1)) parent = await directory(join(parent, part))
  const path = join(parent, parts.at(-1)!)
  const owned = relative(series, path)
  if (owned === '..' || owned.startsWith('../') || isAbsolute(owned)) throw sourceError('AVATAR_SOURCE_ESCAPE', 'The artwork leaves its original series directory.')
  return path
}
async function readFileInSeries(series: string, file: string, maxBytes: number): Promise<Buffer> {
  const path = await filePath(series, file)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maxBytes) throw sourceError('AVATAR_SOURCE_INPUT_LIMIT', 'This individual artwork or declaration exceeds its parser memory boundary.')
    const current = await lstat(path)
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino ||
      await realpath(path) !== path) throw sourceError('AVATAR_SOURCE_CHANGED', 'The original artwork path changed during its read.')
    const buffer = Buffer.alloc(before.size + 1)
    let count = 0
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    const after = await handle.stat()
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs) throw sourceError('AVATAR_SOURCE_CHANGED', 'The original artwork bytes changed during their read. Read this same source again.')
    return buffer.subarray(0, count)
  } finally { await handle.close() }
}

/** GLB protocol/container facts only. Rendering remains the original client renderer's responsibility. */
function validateGlb(bytes: Buffer, definition: Extract<MoteAvatarSeriesDefinition, { kind: 'glb' }>,
  createImage: (bytes: Buffer) => NativeImage): void {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length) fail('Choose an intact original glTF 2.0 binary container.')
  let json: NativeObject | undefined, binary: Buffer | undefined
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail('The GLB chunk header is incomplete.')
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4)
    if (length % 4 || offset + 8 + length > bytes.length) fail('The GLB chunk length is invalid.')
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    if (offset === 12 && type !== 0x4e4f534a) fail('The original GLB must begin with its JSON chunk.')
    if (type === 0x4e4f534a) {
      if (json) fail('The original GLB contains conflicting JSON chunks.')
      try { json = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chunk))) }
      catch { fail('The original GLB JSON could not be read.') }
    } else if (type === 0x004e4942) {
      if (binary) fail('The original GLB contains conflicting binary chunks.')
      binary = chunk
    }
    offset += length + 8
  }
  if (!json || object(json.asset).version !== '2.0') fail('The original artwork is not supported glTF 2.0.')
  const supported = new Set(['KHR_materials_unlit', 'KHR_materials_clearcoat', 'KHR_materials_ior',
    'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_volume',
    'KHR_materials_emissive_strength', 'KHR_materials_iridescence', 'KHR_materials_sheen',
    'KHR_materials_anisotropy', 'KHR_materials_dispersion', 'KHR_texture_transform', 'KHR_mesh_quantization'])
  for (const extension of items(json.extensionsRequired)) if (typeof extension !== 'string' || !supported.has(extension))
    throw sourceError('AVATAR_GLB_UNSUPPORTED', 'This exact GLB requires a decoder or extension that is not installed for avatar previews.')
  const buffers = items(json.buffers), views = items(json.bufferViews), accessors = items(json.accessors)
  for (const value of buffers) {
    const buffer = object(value)
    if (buffer.uri !== undefined) throw sourceError('AVATAR_GLB_EXTERNAL_RESOURCE', 'Choose a self-contained GLB with its actual buffers embedded.')
    if (buffers.length !== 1 || !binary || number(buffer.byteLength) > binary.length ||
      binary.length - number(buffer.byteLength) > 3) fail('The original GLB binary buffer is incomplete.')
  }
  for (const value of views) {
    const view = object(value), buffer = at(buffers, view.buffer)
    if (number(view.byteOffset ?? 0) + number(view.byteLength) > number(buffer.byteLength)) fail('An original GLB buffer view leaves its actual buffer.')
  }
  const imageSizes: number[] = []
  let embeddedPixels = 0
  for (const value of items(json.images)) {
    const image = object(value)
    if (image.uri !== undefined) throw sourceError('AVATAR_GLB_EXTERNAL_RESOURCE', 'Choose a self-contained GLB with its actual images embedded.')
    const view = at(views, image.bufferView)
    if (!['image/png', 'image/jpeg'].includes(image.mimeType as string)) throw sourceError('AVATAR_GLB_UNSUPPORTED', 'This exact GLB image format is not installed for avatar previews.')
    if (!binary) fail('The original GLB image has no embedded binary data.')
    const offset = number(view.byteOffset ?? 0), imageBytes = binary.subarray(offset, offset + number(view.byteLength))
    // Reuse the original encoded-dimension guard before native allocation, on the true image slice.
    const mimeType = image.mimeType as 'image/png' | 'image/jpeg'
    const decoded = decodeObjectAvatar({ mimeType, dataUrl: 'data:' + mimeType + ';base64,' + imageBytes.toString('base64') }, createImage)
    const size = decoded.getSize()
    const pixels = size.width * size.height
    embeddedPixels += pixels
    if (embeddedPixels > AVATAR_MAX_PIXELS) throw sourceError('AVATAR_GLB_TEXTURE_LIMIT', 'This selected model exceeds the 16 megapixel embedded image validation boundary. Other artwork remains available.')
    imageSizes.push(pixels)
  }
  // A selected model's declared texture slots, not a cumulative catalog cutoff.
  // Count separate slots conservatively: the renderer may use a distinct sampler for each.
  let texturePixels = 0
  for (const value of items(json.textures)) {
    const texture = object(value), source = number(texture.source)
    if (source >= imageSizes.length) fail('An original GLB texture has no actual embedded image.')
    texturePixels += imageSizes[source]!
    if (texturePixels > AVATAR_MAX_PIXELS) throw sourceError('AVATAR_GLB_TEXTURE_LIMIT', 'This selected model exceeds the 16 megapixel decoded texture boundary. Other artwork remains available.')
  }
  const materials = items(json.materials), meshes = items(json.meshes), nodes = items(json.nodes)
  for (const material of definition.materials ?? []) at(materials, material.index)
  if (definition.framing) at(nodes, definition.framing.nodeIndex)
  const accessorCount = (index: unknown): number => {
    const accessor = at(accessors, index), count = number(accessor.count)
    if (!count) fail('The declared artwork accessor has no actual geometry values.')
    const componentBytes: Record<string, number> = { '5120': 1, '5121': 1, '5122': 2, '5123': 2, '5125': 4, '5126': 4 }
    const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
    const elementBytes = componentBytes[String(accessor.componentType)]! * components[String(accessor.type)]!
    if (!elementBytes) fail('The declared morph accessor format is not supported.')
    const range = (viewIndex: unknown, byteOffset: unknown, values: number, size: number, stride = false) => {
      const view = at(views, viewIndex), step = stride ? number(view.byteStride ?? size) : size
      if (step < size || number(byteOffset ?? 0) + (values - 1) * step + size > number(view.byteLength))
        fail('The declared morph accessor leaves its original buffer view.')
    }
    if (accessor.bufferView !== undefined) range(accessor.bufferView, accessor.byteOffset, count, elementBytes, true)
    if (accessor.sparse !== undefined) {
      const sparse = object(accessor.sparse), sparseCount = number(sparse.count)
      if (!sparseCount || sparseCount > count) fail('The original sparse morph accessor count is invalid.')
      const indices = object(sparse.indices), values = object(sparse.values)
      const indexBytes: Record<string, number> = { '5121': 1, '5123': 2, '5125': 4 }
      const size = indexBytes[String(indices.componentType)]
      if (!size) fail('The original sparse morph index format is invalid.')
      range(indices.bufferView, indices.byteOffset, sparseCount, size)
      range(values.bufferView, values.byteOffset, sparseCount, elementBytes)
    } else if (accessor.bufferView === undefined) fail('The declared morph accessor has no original buffer data.')
    return count
  }
  for (const morph of definition.morphs ?? []) {
    const mesh = at(meshes, morph.meshIndex), primitives = items(mesh.primitives)
    if (!primitives.length) fail('The declared morph mesh has no actual primitives.')
    for (const value of primitives) {
      const primitive = object(value), target = at(items(primitive.targets), morph.targetIndex)
      if (!Object.keys(target).length) fail('The declared morph has no actual geometry attributes.')
      const attributes = object(primitive.attributes)
      for (const [semantic, index] of Object.entries(target)) if (accessorCount(index) !== accessorCount(attributes[semantic]))
        fail('The declared morph does not match its original geometry value count.')
    }
  }
}

/** Original Host artwork sources. Creating a collection never publishes an avatar or configuration. */
export class MoteAvatarSeriesOwner {
  constructor(private readonly options: { userRoot: string; builtinRoot: string },
    private readonly createImage: (bytes: Buffer) => NativeImage = bytes => nativeImage.createFromBuffer(bytes)) {
    if (!isAbsolute(options.userRoot) || !isAbsolute(options.builtinRoot)) throw sourceError('AVATAR_ROOT_INVALID', 'Avatar source roots must be the exact original Host directories.')
  }
  private root(origin: Origin): string { return origin === 'user' ? this.options.userRoot : this.options.builtinRoot }

  async createSeries(raw: MoteAvatarSeriesCreateParams): Promise<MoteAvatarSeriesCreateResult> {
    const input = parseMoteAvatarSeriesParams('space.mote.avatar.series.create', raw)
    // Validate the actual approved sample before touching the user source tree.
    const builtin = await directory(this.options.builtinRoot)
    const sample = await readFileInSeries(builtin, 'lowpoly/lowpoly-owl.png', AVATAR_INPUT_MAX_BYTES)
    decodeObjectAvatar({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + sample.toString('base64') }, this.createImage)
    const root = await ensureUserDirectory(this.options.userRoot)
    const path = join(root, input.seriesId)
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw sourceError('AVATAR_SERIES_EXISTS', 'This avatar series directory already exists. Its original files are unchanged; choose another directory name or inspect the current series.')
      throw sourceError('AVATAR_SERIES_CREATE_FAILED', 'The new avatar directory could not be created. Existing series remain available. ' + (error instanceof Error ? error.message : String(error)))
    }
    const identity = await lstat(path), rootIdentity = await lstat(root)
    const unchanged = async () => {
      const currentRoot = await lstat(root), current = await lstat(path)
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino ||
        !current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || await realpath(path) !== path)
        throw sourceError('AVATAR_SOURCE_CHANGED', 'The exact new avatar directory changed during creation. Partial content is retained; inspect this original source before another create.')
    }
    const manifest = { schema: 'agentmux.avatar-series.v1', title: input.title, entries: [
      { id: 'starter', title: 'Owl image', definition: { kind: 'image', file: 'starter.png' } },
      { id: 'face', title: 'Face preset', definition: { kind: 'face2d', face: { ...DEFAULT_MOTE_FACE } } }
    ] }
    const readme = `# ${input.title}\n\nThis is your avatar collection. Creating it does not change any saved avatar.\n\n` +
      '## Images\n\nDrop regular PNG or JPG images here. They appear in Series without a declaration. starter.png is copied from the packaged low-poly owl artwork.\n\n' +
      '## Mixed collections\n\nseries.json declares the starter image and a preset using the original Mote face parts. Edit entry titles and face values, or add image entries referring to files in this same directory. Keep the schema agentmux.avatar-series.v1.\n\n' +
      'Faces use kind face, shape, palette, eyes, brows, mouth and accessory. The starter contains a complete valid example. Self-contained GLB entries may also be declared; native material/morph/framing indices must actually exist in that model.\n\n' +
      'Use regular files and directories, not links. Keep all artwork inside this series; remote images, executable scripts and custom shaders are not avatar sources.\n\n' +
      'Refresh Series in the avatar editor, choose an entry and adjust it. Save avatar is a separate explicit action. Existing saved PNGs remain when their editing source is unavailable.\n'
    const files = ['starter.png', 'series.json', 'README.md']
    try {
      for (const [file, bytes] of [['starter.png', sample], ['series.json', JSON.stringify(manifest, null, 2) + '\n'], ['README.md', readme]] as const) {
        await unchanged()
        const handle = await open(join(path, file), 'wx', 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        await unchanged()
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await handle.sync() } finally { await handle.close() }
      await unchanged()
    } catch (error) {
      throw sourceError('AVATAR_SERIES_CREATE_INCOMPLETE', 'The new avatar series could not be completed at ' + path + '. Any files already created are retained; inspect this folder and the current catalog before another create. ' + (error instanceof Error ? error.message : String(error)))
    }
    return parseMoteAvatarSeriesResult('space.mote.avatar.series.create', { seriesId: input.seriesId, title: input.title, path, files, state: 'created' }, input)
  }

  async revealSeries(raw: MoteAvatarSeriesRevealParams): Promise<string> {
    const input = parseMoteAvatarSeriesParams('space.mote.avatar.series.reveal', raw)
    const root = await directory(this.options.userRoot)
    if (root !== resolve(this.options.userRoot)) throw sourceError('AVATAR_SOURCE_LINK', 'The original user avatar directory has a linked ancestor.')
    const path = join(root, input.seriesId), actual = await directory(path)
    if (actual !== path) throw sourceError('AVATAR_SOURCE_LINK', 'The exact avatar series directory is linked. Existing artwork is retained.')
    return path
  }

  private async series(origin: Origin, root: string, seriesId: string): Promise<{ series: Series; path: string; issues: MoteAvatarSeriesIssue[] }> {
    parseMoteAvatarSeriesLocator({ origin, seriesId, entryId: '_' })
    const path = await directory(join(root, seriesId)), files = await readdir(path, { withFileTypes: true })
    const ordinary = files.filter(file => file.isFile() && IMAGE_FILE.test(file.name)).map(file => file.name).sort()
    const entries: Series['entries'] = []
    // One series' diagnostics must not amplify a small declaration into an unusable RPC frame.
    // Keep every valid entry; only repeated error classes are summarized with exact counts.
    const groups = new Map<string, { first: MoteAvatarSeriesIssue; count: number; examples: string[] }>()
    const addIssue = (error: unknown, source?: MoteAvatarSeriesLocator, sourcePath?: string) => {
      const value = issue(error, source, sourcePath)
      const example = ((source ? source.entryId + ': ' : '') + value.message).slice(0, 512)
      const group = groups.get(value.code)
      if (!group) groups.set(value.code, { first: value, count: 1, examples: [example] })
      else {
        group.count++
        if (group.examples.length < 3 && !group.examples.includes(example)) group.examples.push(example)
      }
    }
    let name = seriesId
    try {
      const bytes = await readFileInSeries(path, 'series.json', MANIFEST_MAX_BYTES)
      const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw sourceError('AVATAR_MANIFEST_INVALID', 'This series declaration is not an object.')
      const record = manifest as NativeObject
      if (record.schema !== 'agentmux.avatar-series.v1' || !Array.isArray(record.entries) ||
        Object.keys(record).some(key => !['schema', 'title', 'entries'].includes(key))) throw sourceError('AVATAR_MANIFEST_INVALID', 'This exact series declaration has an unsupported schema or fields.')
      if (record.title !== undefined) {
        if (title(record.title)) name = record.title
        else addIssue(sourceError('AVATAR_MANIFEST_INVALID', 'The series title is invalid; its original directory identity and other artwork are retained.'), undefined, join(path, 'series.json'))
      }
      const seen = new Set<string>(), conflicts = new Set<string>()
      for (const raw of record.entries) {
        let source: MoteAvatarSeriesLocator | undefined
        try {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw sourceError('AVATAR_DEFINITION_INVALID', 'This declared artwork entry is invalid.')
          const entry = raw as NativeObject
          source = parseMoteAvatarSeriesLocator({ origin, seriesId, entryId: entry.id }) as MoteAvatarSeriesLocator
          if (seen.has(source.entryId)) { conflicts.add(source.entryId); throw sourceError('AVATAR_ENTRY_CONFLICT', 'This declaration repeats an exact entry identity. Neither conflicting declaration is selected.') }
          seen.add(source.entryId)
          if (!title(entry.title) || Object.keys(entry).some(key => !['id', 'title', 'definition'].includes(key))) throw sourceError('AVATAR_DEFINITION_INVALID', 'This declared artwork title or fields are invalid.')
          const definition = parseMoteAvatarSeriesDefinition(entry.definition)
          if (ordinary.includes(source.entryId) && !(definition.kind === 'image' && definition.file === source.entryId))
            throw sourceError('AVATAR_ENTRY_CONFLICT', 'This declared entry conflicts with an original ordinary image identity.')
          entries.push({ entryId: source.entryId, title: entry.title, definition })
        } catch (error) { addIssue(error, source, source ? undefined : join(path, 'series.json')) }
      }
      for (let index = entries.length - 1; index >= 0; index--) if (conflicts.has(entries[index]!.entryId)) entries.splice(index, 1)
    } catch (error) { if (!missing(error)) addIssue(error, undefined, join(path, 'series.json')) }
    const named = new Set(entries.flatMap(entry => entry.definition.kind === 'image' ? [entry.definition.file] : []))
    const declared = new Set(entries.map(entry => entry.entryId))
    for (const file of ordinary) {
      if (named.has(file) || declared.has(file)) continue
      let source: MoteAvatarSeriesLocator | undefined
      try {
        source = parseMoteAvatarSeriesLocator({ origin, seriesId, entryId: file }) as MoteAvatarSeriesLocator
        const definition = parseMoteAvatarSeriesDefinition({ kind: 'image', file })
        entries.push({ entryId: source.entryId, title: file, definition })
      } catch (error) { addIssue(error, source, join(path, file)) }
    }
    for (const file of files) if (file.isSymbolicLink() && (IMAGE_FILE.test(file.name) || file.name === 'series.json'))
      addIssue(sourceError('AVATAR_SOURCE_LINK', 'An avatar source link is not an original regular file. Other artwork remains available.'), undefined, join(path, file.name))
    const issues: MoteAvatarSeriesIssue[] = []
    for (const group of groups.values()) {
      if (group.count === 1) issues.push(group.first)
      else issues.push({
        code: group.first.code, count: group.count,
        message: (path + ': ' + group.count + ' ' + group.first.code + ' diagnostics. Examples: ' + group.examples.join('; ')).slice(0, 2048),
        recovery: group.first.recovery
      })
    }
    return { series: { origin, seriesId, title: name, entries }, path, issues }
  }

  async list(): Promise<MoteAvatarSeriesCatalog> {
    const result: MoteAvatarSeriesCatalog = { roots: [], series: [], issues: [] }
    for (const origin of ['builtin', 'user'] as const) {
      const path = this.root(origin)
      let root: string
      try {
        root = await directory(path)
        const entries = await readdir(root, { withFileTypes: true })
        result.roots.push({ origin, path, state: 'available' })
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory()) {
            if (entry.isSymbolicLink()) result.issues.push(issue(sourceError('AVATAR_SOURCE_LINK', 'A linked series is not an original regular directory. Other series remain available.'), undefined, join(root, entry.name)))
            continue
          }
          try {
            const read = await this.series(origin, root, entry.name)
            result.series.push(read.series)
            for (const problem of read.issues) result.issues.push(problem)
          } catch (error) { result.issues.push(issue(error, undefined, join(root, entry.name))) }
        }
      } catch (error) {
        result.roots.push({ origin, path, state: missing(error) ? 'missing' : 'unavailable' })
        if (!missing(error)) result.issues.push(issue(error, undefined, path))
      }
    }
    return parseMoteAvatarSeriesResult('space.mote.avatar.list', result, {})
  }

  async preview(raw: MoteAvatarSeriesPreviewParams): Promise<MoteAvatarSeriesPrepared> {
    const params = parseMoteAvatarSeriesParams('space.mote.avatar.preview', raw)
    const locator = params.source
    const root = await directory(this.root(locator.origin))
    const read = await this.series(locator.origin, root, locator.seriesId)
    const entry = read.series.entries.find(entry => entry.entryId === locator.entryId)
    if (!entry) throw sourceError('AVATAR_ENTRY_UNAVAILABLE', 'The exact original avatar entry is unavailable. Its saved appearance and other artwork are retained; restore this source and read it again.')
    const definition = entry.definition
    const bytes = definition.kind === 'face2d' ? Buffer.alloc(0) : await readFileInSeries(read.path, definition.file,
      definition.kind === 'glb' ? GLB_MAX_BYTES : AVATAR_INPUT_MAX_BYTES)
    const revision = 'sha256:' + createHash('sha256').update(avatarSeriesCanonical(definition)).update('\0').update(bytes).digest('hex')
    if (params.expectedRevision !== undefined && params.expectedRevision !== revision)
      throw sourceError('AVATAR_SOURCE_REVISION_CONFLICT', 'The exact original artwork changed. Its saved avatar and draft are retained; review this same source before saving again.')
    let payload: MoteAvatarSeriesPrepared['payload']
    if (definition.kind === 'face2d') payload = { kind: 'face2d', face: definition.face }
    else if (definition.kind === 'image') {
      const mimeType = /\.png$/iu.test(definition.file) ? 'image/png' as const : 'image/jpeg' as const
      const image = decodeObjectAvatar({ mimeType, dataUrl: 'data:' + mimeType + ';base64,' + bytes.toString('base64') }, this.createImage)
      payload = { kind: 'image', image: previewObjectAvatar(image) }
    } else {
      validateGlb(bytes, definition, this.createImage)
      payload = { kind: 'glb', dataBase64: bytes.toString('base64') }
    }
    return parseMoteAvatarSeriesResult('space.mote.avatar.preview', {
      source: { ...locator, revision }, definition, payload,
      issues: read.issues.filter(problem => !problem.source || problem.source.entryId === locator.entryId)
    }, params)
  }
}
