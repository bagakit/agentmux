import { isObjectId } from '@agentmux/identity'
import { CAPSULE_METHODS, type CapsuleMethod, type CapsuleParamsMap, type CapsuleResultMap } from './types.js'

type Obj = Record<string, unknown>
export class CapsuleValidationError extends TypeError {
  readonly code = 'invalid-params'
  constructor(message: string) {
    super(message)
    this.name = 'CapsuleValidationError'
  }
}
function fail(path: string): never {
  throw new CapsuleValidationError(`Invalid Capsule value at ${path}.`)
}
function obj(v: unknown, keys: readonly string[], path: string): Obj {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  )
    fail(path)
  const r = v as Obj
  for (const key of Object.keys(r)) if (!keys.includes(key)) fail(`${path}.${key}`)
  return r
}
function str(v: unknown, path: string, empty = false): string {
  if (typeof v !== 'string' || (!empty && !v.trim()) || v.includes('\0')) fail(path)
  return v
}
function id(v: unknown, path: string): string {
  if (!isObjectId(v)) fail(path)
  return v
}
function num(v: unknown, path: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) fail(path)
  return v
}
function en(v: unknown, choices: readonly string[], path: string): string {
  if (typeof v !== 'string' || !choices.includes(v)) fail(path)
  return v
}
function bool(v: unknown, path: string): void {
  if (typeof v !== 'boolean') fail(path)
}
function opt(r: Obj, key: string, check: (v: unknown, p: string) => unknown, path: string): void {
  if (Object.hasOwn(r, key)) check(r[key], `${path}.${key}`)
}
function path(v: unknown, at: string): string {
  const p = str(v, at)
  if (!p.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(p)) fail(at)
  return p
}
function entry(v: unknown, at: string): void {
  const p = str(v, at)
  if (
    p.startsWith('/') ||
    p.includes('\\') ||
    p.split('/').some((s) => !s || s === '.' || s === '..') ||
    /^[A-Za-z]:/u.test(p)
  )
    fail(at)
}
function storage(v: unknown, p: string): void {
  en(v, ['managed', 'path'], p)
}
function mode(v: unknown, p: string): void {
  en(v, ['isolated', 'injected'], p)
}
function theme(v: unknown, p: string): void {
  en(v, ['follow', 'none'], p)
}
function routing(v: unknown, p: string): void {
  en(v, ['file', 'spa'], p)
}
function target(v: unknown, p: string): void {
  const r = obj(v, ['hostId', 'agentSessionId'], p)
  str(r.hostId, `${p}.hostId`)
  str(r.agentSessionId, `${p}.agentSessionId`)
}
function caller(v: unknown, p: string): void {
  const r = obj(v, ['hostId', 'agentSessionId'], p)
  str(r.hostId, `${p}.hostId`)
  opt(r, 'agentSessionId', str, p)
}
function source(v: unknown, p: string): void {
  const r = obj(v, ['toolId', 'executionId', 'agentSessionId'], p)
  for (const k of Object.keys(r)) str(r[k], `${p}.${k}`)
}
function run(v: unknown, p: string): void {
  const r = obj(v, ['runId'], p)
  str(r.runId, `${p}.runId`)
}
function principal(v: unknown, p: string): void {
  const r = obj(v, ['kind', 'id'], p)
  en(r.kind, ['user', 'device'], `${p}.kind`)
  str(r.id, `${p}.id`)
}
function json(v: unknown, p: string, seen = new Set<object>()): void {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return
  if (typeof v === 'number' && Number.isFinite(v)) return
  if (!v || typeof v !== 'object' || seen.has(v)) fail(p)
  seen.add(v)
  if (Array.isArray(v)) v.forEach((x, i) => json(x, `${p}[${i}]`, seen))
  else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail(p)
    for (const [key, value] of Object.entries(v)) json(value, `${p}.${key}`, seen)
  }
  seen.delete(v)
}
export function parseCapsulePreparedReply(v: unknown): import('./types.js').CapsulePreparedReply {
  const p = 'preparedReply'
  const r = obj(
    v,
    [
      'version',
      'operationId',
      'capsuleId',
      'interactionId',
      'inputOperationId',
      'target',
      'expectedRun',
      'principal',
      'prompt',
      'adapterData',
    ],
    p,
  )
  if (r.version !== 1) fail(`${p}.version`)
  str(r.operationId, `${p}.operationId`)
  id(r.capsuleId, `${p}.capsuleId`)
  id(r.interactionId, `${p}.interactionId`)
  str(r.inputOperationId, `${p}.inputOperationId`)
  target(r.target, `${p}.target`)
  run(r.expectedRun, `${p}.expectedRun`)
  principal(r.principal, `${p}.principal`)
  str(r.prompt, `${p}.prompt`)
  opt(r, 'adapterData', json, p)
  return structuredClone(r) as unknown as import('./types.js').CapsulePreparedReply
}
export function parseCapsuleInputObservation(v: unknown): import('./types.js').CapsuleInputObservation {
  const p = 'inputObservation'
  const r = obj(v, ['status', 'inputOperationId', 'expectedRun', 'inputStatus', 'reason', 'receipt'], p)
  en(r.status, ['unavailable', 'submitted', 'unknown'], `${p}.status`)
  str(r.inputOperationId, `${p}.inputOperationId`)
  run(r.expectedRun, `${p}.expectedRun`)
  opt(
    r,
    'inputStatus',
    (x, at) => en(x, ['waiting', 'stopped', 'terminal-confirmed', 'admitted', 'not-applied', 'unknown'], at),
    p,
  )
  opt(r, 'reason', str, p)
  opt(r, 'receipt', json, p)
  return structuredClone(r) as unknown as import('./types.js').CapsuleInputObservation
}
function replyState(v: unknown, p: string): void {
  const r = obj(v, ['operationId', 'phase', 'delivery'], p)
  str(r.operationId, `${p}.operationId`)
  en(r.phase, ['prepared', 'dispatch-started', 'observed'], `${p}.phase`)
  parseCapsuleInputObservation(r.delivery)
}
function changes(v: unknown, p: string, config = false): void {
  const r = obj(
    v,
    config
      ? ['contentRoot', 'defaultStorageMode', 'defaultMode', 'defaultTheme']
      : ['title', 'sourcePath', 'mode', 'theme', 'entry', 'routing'],
    p,
  )
  if (!Object.keys(r).length) fail(p)
  if (config) {
    opt(r, 'contentRoot', path, p)
    opt(r, 'defaultStorageMode', storage, p)
    opt(r, 'defaultMode', mode, p)
    opt(r, 'defaultTheme', theme, p)
  } else {
    opt(r, 'title', str, p)
    opt(r, 'sourcePath', path, p)
    opt(r, 'mode', mode, p)
    opt(r, 'theme', theme, p)
    opt(r, 'entry', entry, p)
    opt(r, 'routing', routing, p)
  }
}
export function isCapsuleMethod(v: unknown): v is CapsuleMethod {
  return typeof v === 'string' && Object.hasOwn(CAPSULE_METHODS, v)
}
export function parseCapsuleParams<M extends CapsuleMethod>(method: M, v: unknown): CapsuleParamsMap[M] {
  if (!isCapsuleMethod(method)) fail('method')
  let keys: string[]
  switch (method) {
    case 'capsule.ls':
    case 'capsule.config.inspect':
      keys = []
      break
    case 'capsule.inspect':
    case 'capsule.resolve':
    case 'capsule.interaction.ls':
      keys = ['capsuleId']
      break
    case 'capsule.create':
      keys = [
        'operationId',
        'sourcePath',
        'title',
        'storageMode',
        'mode',
        'theme',
        'entry',
        'routing',
        'source',
        'target',
      ]
      break
    case 'capsule.update':
      keys = ['capsuleId', 'operationId', 'expectedRevision', 'changes']
      break
    case 'capsule.remove':
      keys = ['capsuleId', 'operationId', 'expectedRevision', 'deleteContent']
      break
    case 'capsule.operation.inspect':
      keys = ['operationId']
      break
    case 'capsule.config.update':
      keys = ['operationId', 'expectedRevision', 'changes']
      break
    case 'capsule.open':
      keys = ['capsuleId', 'operationId', 'placement']
      break
    case 'capsule.interaction.request':
      keys = ['capsuleId', 'operationId', 'question', 'draft']
      break
    case 'capsule.interaction.inspect':
      keys = ['capsuleId', 'interactionId']
      break
    case 'capsule.interaction.draft':
      keys = ['capsuleId', 'interactionId', 'operationId', 'expectedRevision', 'draft']
      break
    case 'capsule.interaction.reply':
      keys = ['capsuleId', 'interactionId', 'operationId', 'expectedRevision', 'answer']
      break
  }
  const r = obj(v, keys, 'params')
  if (keys.includes('capsuleId')) id(r.capsuleId, 'params.capsuleId')
  if (keys.includes('interactionId')) id(r.interactionId, 'params.interactionId')
  if (keys.includes('operationId')) str(r.operationId, 'params.operationId')
  if (keys.includes('expectedRevision')) num(r.expectedRevision, 'params.expectedRevision', 1)
  if (method === 'capsule.create') {
    path(r.sourcePath, 'params.sourcePath')
    opt(r, 'title', str, 'params')
    opt(r, 'storageMode', storage, 'params')
    opt(r, 'mode', mode, 'params')
    opt(r, 'theme', theme, 'params')
    opt(r, 'entry', entry, 'params')
    opt(r, 'routing', routing, 'params')
    opt(r, 'target', target, 'params')
    opt(r, 'source', source, 'params')
  }
  if (method === 'capsule.update' || method === 'capsule.config.update')
    changes(r.changes, 'params.changes', method === 'capsule.config.update')
  if (method === 'capsule.remove') opt(r, 'deleteContent', bool, 'params')
  if (method === 'capsule.interaction.request') {
    str(r.question, 'params.question')
    opt(r, 'draft', (v, p) => str(v, p, true), 'params')
  }
  if (method === 'capsule.interaction.draft') str(r.draft, 'params.draft', true)
  if (method === 'capsule.interaction.reply') str(r.answer, 'params.answer', true)
  // Placement is owned and parsed by the exact host's space adapter, not by this UI-free domain.
  return structuredClone(r) as unknown as CapsuleParamsMap[M]
}
export function parseCapsuleRecord(v: unknown): import('./types.js').CapsuleRecord {
  const p = 'record',
    r = obj(
      v,
      [
        'capsuleId',
        'title',
        'revision',
        'storageMode',
        'contentRoot',
        'sourcePath',
        'entry',
        'routing',
        'mode',
        'theme',
        'port',
        'createdAt',
        'updatedAt',
        'source',
        'caller',
        'target',
      ],
      p,
    )
  id(r.capsuleId, `${p}.capsuleId`)
  str(r.title, `${p}.title`)
  num(r.revision, `${p}.revision`, 1)
  storage(r.storageMode, `${p}.storageMode`)
  path(r.contentRoot, `${p}.contentRoot`)
  path(r.sourcePath, `${p}.sourcePath`)
  entry(r.entry, `${p}.entry`)
  routing(r.routing, `${p}.routing`)
  mode(r.mode, `${p}.mode`)
  theme(r.theme, `${p}.theme`)
  const port = num(r.port, `${p}.port`, 1)
  if (port > 65535) fail(`${p}.port`)
  num(r.createdAt, `${p}.createdAt`)
  num(r.updatedAt, `${p}.updatedAt`)
  opt(r, 'source', source, p)
  opt(r, 'caller', caller, p)
  opt(r, 'target', target, p)
  return structuredClone(r) as unknown as import('./types.js').CapsuleRecord
}
export function parseCapsuleConfig(v: unknown): import('./types.js').CapsuleConfig {
  const r = obj(v, ['revision', 'contentRoot', 'defaultStorageMode', 'defaultMode', 'defaultTheme'], 'config')
  num(r.revision, 'config.revision', 1)
  path(r.contentRoot, 'config.contentRoot')
  storage(r.defaultStorageMode, 'config.defaultStorageMode')
  mode(r.defaultMode, 'config.defaultMode')
  theme(r.defaultTheme, 'config.defaultTheme')
  return structuredClone(r) as unknown as import('./types.js').CapsuleConfig
}
function issue(v: unknown, p: string): void {
  const r = obj(v, ['code', 'stage', 'message', 'recovery', 'capsuleId'], p)
  str(r.code, `${p}.code`)
  en(
    r.stage,
    ['registry', 'content', 'endpoint', 'operation', 'injection', 'interaction', 'config'],
    `${p}.stage`,
  )
  str(r.message, `${p}.message`)
  str(r.recovery, `${p}.recovery`)
  opt(r, 'capsuleId', id, p)
}
function array(v: unknown, p: string, check: (v: unknown, p: string) => unknown): void {
  if (!Array.isArray(v)) fail(p)
  v.forEach((x, i) => check(x, `${p}[${i}]`))
}
function endpoint(v: unknown, p: string): void {
  const r = obj(v, ['status', 'url', 'port', 'instanceId', 'observedAt', 'issue'], p)
  en(r.status, ['available', 'unavailable'], `${p}.status`)
  const port = num(r.port, `${p}.port`, 1)
  if (port > 65535) fail(`${p}.port`)
  num(r.observedAt, `${p}.observedAt`)
  if (r.status === 'available') {
    id(r.instanceId, `${p}.instanceId`)
    str(r.url, `${p}.url`)
    let u: URL
    try {
      u = new URL(r.url as string)
    } catch {
      fail(`${p}.url`)
    }
    if (
      u.protocol !== 'http:' ||
      u.hostname !== '127.0.0.1' ||
      Number(u.port) !== port ||
      u.username ||
      u.password
    )
      fail(`${p}.url`)
    if ('issue' in r) fail(`${p}.issue`)
  } else {
    issue(r.issue, `${p}.issue`)
    if ('url' in r) fail(`${p}.url`)
    if ('instanceId' in r) fail(`${p}.instanceId`)
  }
}
function content(v: unknown, p: string): void {
  const r = obj(v, ['status', 'observedAt', 'issue'], p)
  en(r.status, ['available', 'unavailable'], `${p}.status`)
  num(r.observedAt, `${p}.observedAt`)
  if (r.status === 'unavailable') issue(r.issue, `${p}.issue`)
  else if ('issue' in r) fail(`${p}.issue`)
}
function inspection(v: unknown, p: string, mutation = false): Obj {
  const r = obj(
    v,
    ['record', 'content', 'endpoint', 'issues', ...(mutation ? ['operationId', 'status'] : [])],
    p,
  )
  const record = parseCapsuleRecord(r.record)
  content(r.content, `${p}.content`)
  endpoint(r.endpoint, `${p}.endpoint`)
  if ((r.endpoint as Obj).port !== record.port) fail(`${p}.endpoint.port`)
  array(r.issues, `${p}.issues`, issue)
  if (mutation) {
    str(r.operationId, `${p}.operationId`)
    en(r.status, ['committed'], `${p}.status`)
  }
  return r
}
export function parseCapsuleInteraction(v: unknown): import('./types.js').CapsuleInteraction {
  const p = 'interaction',
    r = obj(
      v,
      [
        'interactionId',
        'capsuleId',
        'operationId',
        'revision',
        'question',
        'draft',
        'createdAt',
        'updatedAt',
        'target',
        'status',
        'answer',
        'reply',
      ],
      p,
    )
  id(r.interactionId, `${p}.interactionId`)
  id(r.capsuleId, `${p}.capsuleId`)
  str(r.operationId, `${p}.operationId`)
  num(r.revision, `${p}.revision`, 1)
  str(r.question, `${p}.question`)
  str(r.draft, `${p}.draft`, true)
  num(r.createdAt, `${p}.createdAt`)
  num(r.updatedAt, `${p}.updatedAt`)
  opt(r, 'target', target, p)
  en(r.status, ['pending', 'answered'], `${p}.status`)
  opt(r, 'answer', (v, p) => str(v, p, true), p)
  opt(r, 'reply', replyState, p)
  if (r.status === 'answered' && !Object.hasOwn(r, 'answer')) fail(`${p}.answer`)
  return structuredClone(r) as unknown as import('./types.js').CapsuleInteraction
}
export function parseCapsuleOperation(v: unknown): import('./types.js').CapsuleOperation {
  const r = obj(
    v,
    [
      'operationId', 'capsuleId', 'inputOperationId', 'method', 'status',
      'createdAt', 'updatedAt', 'result', 'issue',
    ],
    'operation',
  )
  str(r.operationId, 'operation.operationId')
  opt(r, 'capsuleId', id, 'operation')
  opt(r, 'inputOperationId', id, 'operation')
  if (!isCapsuleMethod(r.method)) fail('operation.method')
  if (r.inputOperationId !== undefined && r.method !== 'capsule.interaction.reply')
    fail('operation.inputOperationId')
  en(r.status, ['pending', 'committed', 'failed'], 'operation.status')
  num(r.createdAt, 'operation.createdAt')
  num(r.updatedAt, 'operation.updatedAt')
  opt(r, 'issue', issue, 'operation')
  if (r.status === 'committed' || Object.hasOwn(r, 'result')) {
    if (r.method === 'capsule.operation.inspect') fail('operation.method')
    parseCapsuleResult(r.method, r.result)
    const result = r.result as Obj
    if (result.operationId !== undefined && result.operationId !== r.operationId)
      fail('operation.result.operationId')
    const record = result.record as Obj | undefined
    const interaction = result.interaction as Obj | undefined
    if (
      r.inputOperationId !== undefined &&
      r.inputOperationId !== (result.delivery as Obj | undefined)?.inputOperationId
    )
      fail('operation.result.inputOperationId')
    const capsuleId = record?.capsuleId ?? interaction?.capsuleId ?? result.capsuleId
    if (r.capsuleId !== undefined && capsuleId !== undefined && r.capsuleId !== capsuleId)
      fail('operation.result.capsuleId')
  }
  return structuredClone(r) as unknown as import('./types.js').CapsuleOperation
}
export function parseCapsuleResult<M extends CapsuleMethod>(
  method: M,
  v: unknown,
  input?: CapsuleParamsMap[M],
): CapsuleResultMap[M] {
  if (!isCapsuleMethod(method)) fail('method')
  let r: Obj
  switch (method) {
    case 'capsule.ls':
      r = obj(v, ['capsules', 'issues'], 'result')
      array(r.capsules, 'result.capsules', (v, p) => inspection(v, p))
      array(r.issues, 'result.issues', issue)
      break
    case 'capsule.inspect':
      r = inspection(v, 'result')
      break
    case 'capsule.create':
    case 'capsule.update':
      r = inspection(v, 'result', true)
      break
    case 'capsule.resolve':
      r = obj(v, ['capsuleId', 'endpoint'], 'result')
      id(r.capsuleId, 'result.capsuleId')
      endpoint(r.endpoint, 'result.endpoint')
      break
    case 'capsule.remove':
      r = obj(v, ['operationId', 'status', 'capsuleId', 'deletedContent'], 'result')
      str(r.operationId, 'result.operationId')
      en(r.status, ['committed'], 'result.status')
      id(r.capsuleId, 'result.capsuleId')
      bool(r.deletedContent, 'result.deletedContent')
      break
    case 'capsule.operation.inspect':
      r = obj(v, ['operation'], 'result')
      if (r.operation !== null) parseCapsuleOperation(r.operation)
      break
    case 'capsule.config.inspect':
      r = obj(v, ['config'], 'result')
      parseCapsuleConfig(r.config)
      break
    case 'capsule.config.update':
      r = obj(v, ['operationId', 'status', 'config'], 'result')
      str(r.operationId, 'result.operationId')
      en(r.status, ['committed'], 'result.status')
      parseCapsuleConfig(r.config)
      break
    case 'capsule.open': {
      r = obj(v, ['operationId', 'capsuleId', 'endpoint', 'rendering'], 'result')
      str(r.operationId, 'result.operationId')
      id(r.capsuleId, 'result.capsuleId')
      endpoint(r.endpoint, 'result.endpoint')
      const x = obj(
        r.rendering,
        ['status', 'reason', 'browserId', 'tabId', 'regionId', 'workspaceId'],
        'result.rendering',
      )
      en(x.status, ['available', 'unavailable'], 'result.rendering.status')
      if (x.status === 'available') {
        for (const k of ['browserId', 'tabId', 'regionId']) str(x[k], `result.rendering.${k}`)
        opt(x, 'workspaceId', str, 'result.rendering')
        if ('reason' in x) fail('result.rendering.reason')
      } else {
        str(x.reason, 'result.rendering.reason')
        for (const k of ['browserId', 'tabId', 'regionId', 'workspaceId'])
          if (k in x) fail(`result.rendering.${k}`)
      }
      break
    }
    case 'capsule.interaction.request':
    case 'capsule.interaction.draft':
      r = obj(v, ['operationId', 'interaction'], 'result')
      str(r.operationId, 'result.operationId')
      parseCapsuleInteraction(r.interaction)
      break
    case 'capsule.interaction.inspect':
      r = obj(v, ['interaction'], 'result')
      parseCapsuleInteraction(r.interaction)
      break
    case 'capsule.interaction.ls':
      r = obj(v, ['interactions', 'issues'], 'result')
      array(r.interactions, 'result.interactions', (v) => parseCapsuleInteraction(v))
      array(r.issues, 'result.issues', issue)
      break
    case 'capsule.interaction.reply': {
      r = obj(v, ['operationId', 'interaction', 'delivery'], 'result')
      str(r.operationId, 'result.operationId')
      parseCapsuleInteraction(r.interaction)
      const delivery = parseCapsuleInputObservation(r.delivery)
      const interaction = parseCapsuleInteraction(r.interaction)
      if (
        interaction.reply &&
        (interaction.reply.operationId !== r.operationId ||
          interaction.reply.delivery.inputOperationId !== delivery.inputOperationId ||
          interaction.reply.delivery.expectedRun.runId !== delivery.expectedRun.runId)
      )
        fail('result.delivery')
      break
    }
  }
  if (input) {
    const q = input as Obj
    const rec = r.record as Obj | undefined
    const inter = r.interaction as Obj | undefined
    if (
      q.capsuleId !== undefined &&
      (rec?.capsuleId ?? inter?.capsuleId ?? r.capsuleId) !== undefined &&
      (rec?.capsuleId ?? inter?.capsuleId ?? r.capsuleId) !== q.capsuleId
    )
      fail('result.capsuleId')
    if (q.operationId !== undefined && r.operationId !== undefined && q.operationId !== r.operationId)
      fail('result.operationId')
    if (
      q.interactionId !== undefined &&
      inter?.interactionId !== undefined &&
      q.interactionId !== inter.interactionId
    )
      fail('result.interactionId')
  }
  return structuredClone(r) as unknown as CapsuleResultMap[M]
}
