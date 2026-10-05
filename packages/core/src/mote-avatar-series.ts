import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { isMoteFace, type MoteFace } from './mote-face.js'

/** Data sources and native artwork capabilities; no Agent or Runtime authority. */
export type MoteAvatarSeriesLocator = { origin: 'builtin' | 'user'; seriesId: string; entryId: string }
export type MoteAvatarSeriesSource = MoteAvatarSeriesLocator & { revision: string }
export type MoteAvatarSeriesDefinition =
  | { kind: 'image'; file: string }
  | { kind: 'face2d'; face: MoteFace }
  | { kind: 'glb'; file: string; materials?: Array<{ index: number; role: 'shell' | 'graphic' }>;
      morphs?: Array<{ id: string; label: string; meshIndex: number; targetIndex: number }>;
      framing?: { nodeIndex: number } }
export type MoteAvatarSeriesParameters =
  | { kind: 'image'; zoom: number; offsetX: number; offsetY: number }
  | { kind: 'face2d'; face: MoteFace }
  | { kind: 'glb'; mode: 'hybrid' | 'chrome' | 'toon' | 'original'; roughness: number;
      color: string; morphs: Record<string, number>; yaw: number }
export type MoteAvatarSeriesIssue = { code: string; message: string; source?: MoteAvatarSeriesLocator; recovery: string; count?: number }
export type MoteAvatarSeriesCatalog = {
  roots: Array<{ origin: 'builtin' | 'user'; path: string; state: 'available' | 'missing' | 'unavailable' }>;
  series: Array<{ origin: 'builtin' | 'user'; seriesId: string; title: string;
    entries: Array<{ entryId: string; title: string; definition: MoteAvatarSeriesDefinition }> }>;
  issues: MoteAvatarSeriesIssue[]
}
export type MoteAvatarSeriesPrepared = {
  source: MoteAvatarSeriesSource; definition: MoteAvatarSeriesDefinition;
  payload: { kind: 'image'; image: { dataUrl: string; width: number; height: number } }
    | { kind: 'face2d'; face: MoteFace } | { kind: 'glb'; dataBase64: string };
  issues: MoteAvatarSeriesIssue[]
}
export type MoteAvatarSeriesChoice = {
  kind: 'series'; source: MoteAvatarSeriesSource; definition: MoteAvatarSeriesDefinition;
  parameters: MoteAvatarSeriesParameters; image: { kind: 'image'; fileName: string }
}
export type MoteAvatarSeriesPreviewParams = { source: MoteAvatarSeriesLocator; expectedRevision?: string }
export type MoteAvatarSeriesParameterMap = {
  'space.mote.avatar.list': Record<string, never>;
  'space.mote.avatar.preview': MoteAvatarSeriesPreviewParams
}
export type MoteAvatarSeriesResultMap = {
  'space.mote.avatar.list': MoteAvatarSeriesCatalog;
  'space.mote.avatar.preview': MoteAvatarSeriesPrepared
}
export type MoteAvatarSeriesMethod = keyof MoteAvatarSeriesParameterMap
export interface AgentMuxRpcMoteAvatarsOwner {
  call<M extends MoteAvatarSeriesMethod>(method: M, params: MoteAvatarSeriesParameterMap[M]): Promise<MoteAvatarSeriesResultMap[M]>
}
export const AGENTMUX_RPC_MOTE_AVATAR_METHODS = {
  'space.mote.avatar.list': 'long', 'space.mote.avatar.preview': 'long'
} as const
export function isMoteAvatarSeriesMethod(value: unknown): value is MoteAvatarSeriesMethod {
  return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_MOTE_AVATAR_METHODS, value)
}
function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function text(value: unknown, code: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/u.test(value)) invalid('Avatar data contains an invalid string.', code)
}
function member(value: unknown, values: readonly unknown[], code: string): void {
  if (!values.includes(value)) invalid('Avatar data contains an unsupported value.', code)
}
function index(value: unknown, code: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('An exact native artwork index is required.', code)
}
function number(value: unknown, min: number, max: number, code: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid('Avatar parameter is outside its supported range.', code)
}
function revision(value: unknown, code: string): void {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid('An exact avatar content revision is required.', code)
}
export function avatarSeriesCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(avatarSeriesCanonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + avatarSeriesCanonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
export function parseMoteAvatarSeriesLocator(value: unknown, code = 'INVALID_CONTROL_REQUEST', exact = false): MoteAvatarSeriesLocator | MoteAvatarSeriesSource {
  const p = rpcRecord(value, exact ? ['origin','seriesId','entryId','revision'] : ['origin','seriesId','entryId'], code)
  member(p.origin, ['builtin','user'], code)
  for (const key of ['seriesId','entryId']) {
    text(p[key], code, 255)
    if (p[key] === '.' || p[key] === '..' || /[/\\]/u.test(p[key] as string)) invalid('Choose one exact avatar directory or entry identity.', code)
  }
  if (exact) revision(p.revision, code)
  return p as MoteAvatarSeriesLocator | MoteAvatarSeriesSource
}
export function parseMoteAvatarSeriesDefinition(value: unknown, code = 'INVALID_CONTROL_REQUEST'): MoteAvatarSeriesDefinition {
  const p = rpcRecord(value, ['kind','file','face','materials','morphs','framing'], code)
  member(p.kind, ['image','face2d','glb'], code)
  if (p.kind === 'face2d') {
    rpcRecord(value, ['kind','face'], code)
    if (!isMoteFace(p.face)) invalid('The original 2D face definition is invalid.', code)
  } else {
    rpcRecord(value, p.kind === 'image' ? ['kind','file'] : ['kind','file','materials','morphs','framing'], code)
    text(p.file, code)
    if ((p.file as string).startsWith('/') || /[\\:]/u.test(p.file as string) || (p.file as string).split('/').some(part => !part || part === '.' || part === '..')) invalid('Artwork must be an exact relative file inside its original series.', code)
    if (p.kind === 'image' && !/\.(png|jpe?g)$/iu.test(p.file as string) || p.kind === 'glb' && !/\.glb$/iu.test(p.file as string)) invalid('Choose a supported static image or self-contained GLB.', code)
    if (p.kind === 'glb') {
      if (p.materials !== undefined) {
        if (!Array.isArray(p.materials)) invalid('Native materials must be an array.', code)
        const indices = new Set<number>()
        for (const value of p.materials as unknown[]) {
          const m = rpcRecord(value, ['index','role'], code); index(m.index, code); member(m.role, ['shell','graphic'], code)
          if (indices.has(m.index as number)) invalid('Native material indices cannot repeat.', code)
          indices.add(m.index as number)
        }
      }
      if (p.morphs !== undefined) {
        if (!Array.isArray(p.morphs)) invalid('Native morph controls must be an array.', code)
        const ids = new Set<string>(), targets = new Set<string>()
        for (const value of p.morphs as unknown[]) {
          const m = rpcRecord(value, ['id','label','meshIndex','targetIndex'], code)
          text(m.id, code, 128); text(m.label, code, 120); index(m.meshIndex, code); index(m.targetIndex, code)
          if (['__proto__','constructor','prototype'].includes(m.id as string) || ids.has(m.id as string) || targets.has(m.meshIndex + ':' + m.targetIndex)) invalid('Native morph controls cannot repeat or use reserved keys.', code)
          ids.add(m.id as string); targets.add(m.meshIndex + ':' + m.targetIndex)
        }
      }
      if (p.framing !== undefined) index(rpcRecord(p.framing, ['nodeIndex'], code).nodeIndex, code)
    }
  }
  return p as MoteAvatarSeriesDefinition
}
export function parseMoteAvatarSeriesParameters(value: unknown, definition: MoteAvatarSeriesDefinition, code = 'INVALID_CONTROL_REQUEST'): MoteAvatarSeriesParameters {
  const p = rpcRecord(value, definition.kind === 'image' ? ['kind','zoom','offsetX','offsetY'] : definition.kind === 'face2d' ? ['kind','face'] : ['kind','mode','roughness','color','morphs','yaw'], code)
  if (p.kind !== definition.kind) invalid('Avatar parameters belong to a different source type.', code)
  if (p.kind === 'image') {
    number(p.zoom, 1, 3, code); number(p.offsetX, -1, 1, code); number(p.offsetY, -1, 1, code)
  } else if (p.kind === 'face2d') {
    if (!isMoteFace(p.face)) invalid('The original 2D face parameters are invalid.', code)
  } else if (definition.kind === 'glb') {
    member(p.mode, ['hybrid','chrome','toon','original'], code); number(p.roughness, 0, 1, code); number(p.yaw, -Math.PI, Math.PI, code)
    if (typeof p.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(p.color)) invalid('Choose a literal six-digit material color.', code)
    const morphs = rpcRecord(p.morphs, (definition.morphs ?? []).map(m => m.id), code)
    for (const control of definition.morphs ?? []) number(morphs[control.id], 0, 1, code)
  }
  return p as MoteAvatarSeriesParameters
}
export function parseMoteAvatarSeriesChoice(value: unknown, code = 'INVALID_CONTROL_REQUEST'): MoteAvatarSeriesChoice {
  const p = rpcRecord(value, ['kind','source','definition','parameters','image'], code)
  if (p.kind !== 'series') invalid('Choose a series appearance.', code)
  parseMoteAvatarSeriesLocator(p.source, code, true)
  const definition = parseMoteAvatarSeriesDefinition(p.definition, code)
  parseMoteAvatarSeriesParameters(p.parameters, definition, code)
  const image = rpcRecord(p.image, ['kind','fileName'], code)
  if (image.kind !== 'image' || typeof image.fileName !== 'string' || !/^[a-f0-9]{64}\.png$/u.test(image.fileName)) invalid('A series appearance requires its original immutable PNG reference.', code)
  return p as MoteAvatarSeriesChoice
}
export function isMoteAvatarSeriesChoice(value: unknown): value is MoteAvatarSeriesChoice {
  try { parseMoteAvatarSeriesChoice(value); return true } catch { return false }
}
function issues(value: unknown, code: string): void {
  if (!Array.isArray(value)) invalid('Avatar source issues must be an array.', code)
  for (const item of value as unknown[]) {
    const p = rpcRecord(item, ['code','message','source','recovery','count'], code)
    for (const key of ['code','message','recovery']) text(p[key], code)
    if (p.source !== undefined) parseMoteAvatarSeriesLocator(p.source, code)
    if (p.count !== undefined) { index(p.count, code); if (!(p.count as number)) invalid('Avatar issue counts must be positive.', code) }
  }
}
export function parseMoteAvatarSeriesParams<M extends MoteAvatarSeriesMethod>(method: M, value: unknown): MoteAvatarSeriesParameterMap[M] {
  const p = rpcRecord(value, method === 'space.mote.avatar.list' ? [] : ['source','expectedRevision'])
  if (method === 'space.mote.avatar.preview') {
    parseMoteAvatarSeriesLocator(p.source)
    if (p.expectedRevision !== undefined) revision(p.expectedRevision, 'INVALID_CONTROL_REQUEST')
  }
  return p as MoteAvatarSeriesParameterMap[M]
}
export function parseMoteAvatarSeriesResult<M extends MoteAvatarSeriesMethod>(method: M, value: unknown, input: MoteAvatarSeriesParameterMap[M]): MoteAvatarSeriesResultMap[M] {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, method === 'space.mote.avatar.list' ? ['roots','series','issues'] : ['source','definition','payload','issues'], code)
  issues(p.issues, code)
  if (method === 'space.mote.avatar.list') {
    if (!Array.isArray(p.roots) || !Array.isArray(p.series)) invalid('Avatar catalog metadata is invalid.', code)
    const origins = new Set<string>(), series = new Set<string>()
    for (const value of p.roots as unknown[]) {
      const root = rpcRecord(value, ['origin','path','state'], code)
      member(root.origin, ['builtin','user'], code); text(root.path, code); member(root.state, ['available','missing','unavailable'], code)
      if (origins.has(root.origin as string)) invalid('Avatar roots cannot repeat.', code)
      origins.add(root.origin as string)
    }
    for (const value of p.series as unknown[]) {
      const s = rpcRecord(value, ['origin','seriesId','title','entries'], code)
      parseMoteAvatarSeriesLocator({ origin: s.origin, seriesId: s.seriesId, entryId: '_' }, code); text(s.title, code)
      const key = s.origin + ':' + s.seriesId
      if (!origins.has(s.origin as string) || series.has(key) || !Array.isArray(s.entries)) invalid('Avatar series must retain their exact distinct origin.', code)
      series.add(key); const entries = new Set<string>()
      for (const value of s.entries as unknown[]) {
        const entry = rpcRecord(value, ['entryId','title','definition'], code)
        parseMoteAvatarSeriesLocator({ origin:s.origin,seriesId:s.seriesId,entryId:entry.entryId }, code); text(entry.title, code)
        parseMoteAvatarSeriesDefinition(entry.definition, code)
        if (entries.has(entry.entryId as string)) invalid('Avatar entry identities cannot repeat.', code)
        entries.add(entry.entryId as string)
      }
    }
  } else {
    const source = parseMoteAvatarSeriesLocator(p.source, code, true) as MoteAvatarSeriesSource
    const expected = input as MoteAvatarSeriesPreviewParams
    if (source.origin !== expected.source.origin || source.seriesId !== expected.source.seriesId || source.entryId !== expected.source.entryId || expected.expectedRevision !== undefined && source.revision !== expected.expectedRevision) invalid('Prepared artwork belongs to a different original source or revision.', code)
    const definition = parseMoteAvatarSeriesDefinition(p.definition, code)
    const payload = rpcRecord(p.payload, ['kind','image','face','dataBase64'], code)
    if (payload.kind !== definition.kind) invalid('Prepared artwork has a different source capability.', code)
    rpcRecord(p.payload, definition.kind === 'image' ? ['kind','image'] : definition.kind === 'face2d' ? ['kind','face'] : ['kind','dataBase64'], code)
    if (definition.kind === 'face2d') {
      if (!isMoteFace(payload.face) || avatarSeriesCanonical(payload.face) !== avatarSeriesCanonical(definition.face)) invalid('Prepared face differs from its exact original definition.', code)
    } else if (definition.kind === 'image') {
      const image = rpcRecord(payload.image, ['dataUrl','width','height'], code)
      if (typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith('data:image/png;base64,') || image.dataUrl.length > Math.ceil(2 * 1024 * 1024 / 3) * 4 + 22) invalid('Prepared image is not its bounded original preview.', code)
      const encoded = image.dataUrl.slice('data:image/png;base64,'.length)
      if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) invalid('Prepared image is not valid base64 PNG data.', code)
      for (const edge of ['width','height']) { index(image[edge], code); if (!(image[edge] as number) || (image[edge] as number) > 512) invalid('Prepared image dimensions are invalid.', code) }
    } else if (typeof payload.dataBase64 !== 'string' || !payload.dataBase64.length || payload.dataBase64.length > Math.ceil(32 * 1024 * 1024 / 3) * 4 || payload.dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload.dataBase64)) invalid('Prepared GLB exceeds its single-asset parser memory boundary.', code)
  }
  return p as MoteAvatarSeriesResultMap[M]
}
