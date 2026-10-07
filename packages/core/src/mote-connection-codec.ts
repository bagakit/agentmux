import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import {
  parseMotePreferencesTarget,
  parseMoteConnectionValues,
  parseMotePreferencesSaveParams,
  parseMotePreferencesSaveResult,
  sameMotePreferencesTarget,
  sameMoteConnectionValues
} from './mote-preferences.js'
import { parseConnectionEnrollmentOperation } from './connection-enrollment-codec.js'
import { parseConnectionProfileOperation } from './connection-profile-codec.js'
import type {
  MoteConnectionMethod,
  MoteConnectionSource,
  MoteConnectionOperation,
  MoteConnectionParamsMap,
  MoteConnectionResultMap
} from './mote-connection-contract.js'

export const MOTE_CONNECTION_RPC_METHODS = {
  'space.mote.connection.create': 'long',
  'space.mote.connection.sync': 'long',
  'space.mote.connection.advance': 'long',
  'space.mote.connection.inspect': 'short',
  'space.mote.connection.ls': 'short'
} as const
export const isMoteConnectionMethod = (v: unknown): v is MoteConnectionMethod =>
  typeof v === 'string' && Object.hasOwn(MOTE_CONNECTION_RPC_METHODS, v)
const fail = (): never => {
  throw new AgentMuxError('The original Mote connection request or receipt is unconfirmed.', 'INVALID_MOTE_CONNECTION_DATA')
}
const obj = (v: unknown, keys: string[]) => rpcRecord(v, keys, 'INVALID_MOTE_CONNECTION_DATA')
function text(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || /[\u0000-\u001f\u007f]/u.test(v)) fail()
  return v as string
}
function id(v: unknown): string {
  const s = text(v)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(s)) fail()
  return s
}
function revision(v: unknown): string {
  const s = text(v)
  if (!/^sha256:[a-f0-9]{64}$/u.test(s)) fail()
  return s
}
function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > max) fail()
  return v as number
}
function one<T extends string>(v: unknown, choices: readonly T[]): T {
  if (!choices.includes(v as T)) fail()
  return v as T
}
const ref = (v: unknown) => parseMoteConnectionValues({ connection: v }).connection!
function target(value: unknown) {
  const parsed = parseMotePreferencesTarget(value)
  return {
    spaceId: parsed.spaceId,
    zoneId: parsed.zoneId,
    expectedResource: {
      hostId: parsed.expectedResource.hostId,
      workspaceId: parsed.expectedResource.workspaceId,
      workspacePath: parsed.expectedResource.workspacePath
    }
  }
}
export function parseMoteConnectionSource(v: unknown): MoteConnectionSource {
  const p = obj(v, ['target', 'expectedTopicRevision', 'expectedAvatarRevision'])
  return {
    target: target(p.target),
    expectedTopicRevision: revision(p.expectedTopicRevision),
    expectedAvatarRevision: p.expectedAvatarRevision === null ? null : revision(p.expectedAvatarRevision)
  }
}
export function parseMoteConnectionParams<M extends MoteConnectionMethod>(m: M, v: unknown): MoteConnectionParamsMap[M] {
  if (m === 'space.mote.connection.ls') {
    const p = obj(v, ['target', 'cursor', 'limit'])
    return {
      target: target(p.target),
      ...(p.cursor === undefined ? {} : { cursor: text(p.cursor) }),
      ...(p.limit === undefined ? {} : { limit: integer(p.limit, 100) })
    } as MoteConnectionParamsMap[M]
  }
  if (m === 'space.mote.connection.advance' || m === 'space.mote.connection.inspect') {
    const p = obj(v, ['operationId'])
    return { operationId: id(p.operationId) } as MoteConnectionParamsMap[M]
  }
  const p = obj(
    v,
    m === 'space.mote.connection.create'
      ? ['operationId', 'source', 'adapterId', 'domain', 'avatar']
      : ['operationId', 'source', 'connection', 'expectedConnectionRevision', 'avatar']
  )
  const source = parseMoteConnectionSource(p.source),
    avatar = one(p.avatar, ['include-saved', 'omit'])
  if (avatar === 'include-saved' && !source.expectedAvatarRevision) fail()
  const base = { operationId: id(p.operationId), source, avatar }
  if (m === 'space.mote.connection.sync')
    return {
      ...base,
      connection: ref(p.connection),
      expectedConnectionRevision: integer(p.expectedConnectionRevision)
    } as MoteConnectionParamsMap[M]
  const domain = text(p.domain)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain)) fail()
  return { ...base, adapterId: id(p.adapterId), domain } as MoteConnectionParamsMap[M]
}
export function parseMoteConnectionOperation(v: unknown): MoteConnectionOperation {
  const p = obj(v, [
      'operationId',
      'action',
      'source',
      'snapshot',
      'connection',
      'enrollmentOperationId',
      'profileOperationId',
      'defaultSave',
      'enrollment',
      'profile',
      'defaultLink',
      'issue'
    ]),
    s = obj(p.snapshot, ['name', 'description', 'avatarSha256']),
    d = obj(p.defaultLink, ['state', 'current'])
  const source = parseMoteConnectionSource(p.source),
    connection = p.connection === null ? null : ref(p.connection)
  const snapshot = {
    name: text(s.name),
    description: s.description === null ? null : text(s.description),
    avatarSha256: s.avatarSha256 === null ? null : text(s.avatarSha256)
  }
  if (snapshot.avatarSha256 !== null && !/^[a-f0-9]{64}$/u.test(snapshot.avatarSha256)) fail()
  const c = d.current === null ? null : obj(d.current, ['connection', 'fileRevision'])
  const defaultSave =
    p.defaultSave === null
      ? null
      : (() => {
          const r = obj(p.defaultSave, ['params', 'observedReceipt']),
            params = parseMotePreferencesSaveParams(r.params)
          if (
            params.kind !== 'connection' ||
            !sameMotePreferencesTarget(params.target, source.target) ||
            !sameMoteConnectionValues(params.values, { connection })
          )
            fail()
          return {
            params: params as import('./mote-preferences.js').MoteConnectionPreferencesSaveParams,
            observedReceipt:
              r.observedReceipt === null
                ? null
                : (parseMotePreferencesSaveResult(
                    r.observedReceipt,
                    params
                  ) as import('./mote-preferences.js').MoteConnectionPreferencesSaveResult)
          }
        })()
  const result: MoteConnectionOperation = {
    operationId: id(p.operationId),
    action: one(p.action, ['create', 'sync']),
    source,
    snapshot,
    connection,
    enrollmentOperationId: p.enrollmentOperationId === null ? null : id(p.enrollmentOperationId),
    profileOperationId: id(p.profileOperationId),
    defaultSave,
    enrollment: p.enrollment === null ? null : parseConnectionEnrollmentOperation(p.enrollment),
    profile: p.profile === null ? null : parseConnectionProfileOperation(p.profile),
    defaultLink: {
      state: one(d.state, ['not-requested', 'pending', 'saved', 'conflict', 'unknown']),
      current: c
        ? {
            connection: c.connection === null ? null : ref(c.connection),
            fileRevision: c.fileRevision === null ? null : revision(c.fileRevision)
          }
        : null
    },
    issue:
      p.issue === null
        ? null
        : one(p.issue, [
            'source-unconfirmed',
            'storage-unconfirmed',
            'child-unconfirmed',
            'default-unconfirmed',
            'default-conflict',
            'connection-revised'
          ] as const)
  }
  if (
    (result.action === 'create') !== (result.enrollmentOperationId !== null) ||
    (result.action === 'sync' && (defaultSave !== null || result.defaultLink.state !== 'not-requested' || !connection))
  )
    fail()
  if (
    result.enrollment &&
    (result.enrollment.operationId !== result.enrollmentOperationId ||
      result.enrollment.label !== snapshot.name ||
      result.enrollment.preset?.name !== snapshot.name ||
      result.enrollment.preset?.description !== (snapshot.description ?? undefined) ||
      (connection &&
        (result.enrollment.connectionId !== connection.connectionId ||
          result.enrollment.application?.domain !== connection.application.domain ||
          result.enrollment.application.appId !== connection.application.appId)))
  )
    fail()
  if (result.profile) {
    const pr = result.profile
    if (
      pr.operationId !== result.profileOperationId ||
      !connection ||
      pr.connectionId !== connection.connectionId ||
      pr.application.domain !== connection.application.domain ||
      pr.application.appId !== connection.application.appId ||
      pr.desired.name !== snapshot.name ||
      pr.desired.description !== (snapshot.description ?? undefined) ||
      pr.desired.avatarSha256 !== (snapshot.avatarSha256 ?? undefined)
    )
      fail()
  }
  if (
    result.defaultLink.state === 'saved' &&
    (!defaultSave?.observedReceipt || !['saved', 'unchanged'].includes(defaultSave.observedReceipt.status))
  )
    fail()
  return result
}
export function parseMoteConnectionResult<M extends MoteConnectionMethod>(
  m: M,
  v: unknown,
  i: MoteConnectionParamsMap[M]
): MoteConnectionResultMap[M] {
  if (m === 'space.mote.connection.ls') {
    const p = obj(v, ['operations', 'next'])
    if (!Array.isArray(p.operations) || p.operations.length > ((i as MoteConnectionParamsMap['space.mote.connection.ls']).limit ?? 25))
      fail()
    const operations = (p.operations as unknown[]).map(parseMoteConnectionOperation)
    if (
      new Set(operations.map((o) => o.operationId)).size !== operations.length ||
      operations.some((o) => !sameMotePreferencesTarget(o.source.target, (i as MoteConnectionParamsMap['space.mote.connection.ls']).target))
    )
      fail()
    return { operations, next: p.next === null ? null : text(p.next) } as MoteConnectionResultMap[M]
  }
  const operation =
    m === 'space.mote.connection.inspect'
      ? (() => {
          const p = obj(v, ['operation'])
          return p.operation === null ? null : parseMoteConnectionOperation(p.operation)
        })()
      : parseMoteConnectionOperation(v)
  if (operation && operation.operationId !== (i as { operationId: string }).operationId) fail()
  if (operation && (m === 'space.mote.connection.create' || m === 'space.mote.connection.sync')) {
    const request = i as MoteConnectionParamsMap['space.mote.connection.create'] | MoteConnectionParamsMap['space.mote.connection.sync']
    if (
      operation.action !== (m === 'space.mote.connection.create' ? 'create' : 'sync') ||
      JSON.stringify(operation.source) !== JSON.stringify(request.source) ||
      (request.avatar === 'include-saved') !== (operation.snapshot.avatarSha256 !== null)
    )
      fail()
    if (
      'adapterId' in request &&
      operation.enrollment &&
      (operation.enrollment.adapterId !== request.adapterId || operation.enrollment.domain !== request.domain)
    )
      fail()
    if (
      'connection' in request &&
      (!sameMoteConnectionValues({ connection: request.connection }, { connection: operation.connection }) ||
        (operation.profile && operation.profile.connectionRevision !== request.expectedConnectionRevision))
    )
      fail()
  }
  return (m === 'space.mote.connection.inspect' ? { operation } : operation) as MoteConnectionResultMap[M]
}
