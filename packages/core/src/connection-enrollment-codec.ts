import { sha256 } from '@noble/hashes/sha2.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionRecord } from './connection-record-codec.js'
import type {
  ConnectionEnrollmentAccount,
  ConnectionEnrollmentAction,
  ConnectionEnrollmentActionKind,
  ConnectionEnrollmentBeginInput,
  ConnectionEnrollmentCapability,
  ConnectionEnrollmentChallenge,
  ConnectionEnrollmentDiagnostic,
  ConnectionEnrollmentMethod,
  ConnectionEnrollmentOperation,
  ConnectionEnrollmentParamsMap,
  ConnectionEnrollmentPreset,
  ConnectionEnrollmentPresetSummary,
  ConnectionEnrollmentReason,
  ConnectionEnrollmentResultMap,
  ConnectionEnrollmentView
} from './connection-enrollment-contract.js'
export const CONNECTION_ENROLLMENT_RPC_METHODS = {
  'connection.enrollment.begin': 'long',
  'connection.enrollment.advance': 'long',
  'connection.enrollment.inspect': 'long',
  'connection.enrollment.ls': 'long'
} as const
export const isConnectionEnrollmentMethod = (value: unknown): value is ConnectionEnrollmentMethod =>
  typeof value === 'string' && Object.hasOwn(CONNECTION_ENROLLMENT_RPC_METHODS, value)
const fail = (): never => {
  throw new AgentMuxError(
    'Enrollment data does not describe the original application operation.',
    'INVALID_CONNECTION_ENROLLMENT_DATA'
  )
}
const object = (v: unknown, fields: string[]) =>
  rpcRecord(v, fields, 'INVALID_CONNECTION_ENROLLMENT_DATA')
function text(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || /[\0\r\n]/u.test(v)) fail()
  return v as string
}
function id(v: unknown): string {
  const s = text(v)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(s)) fail()
  return s
}
function domain(v: unknown): string {
  const s = text(v)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(s)) fail()
  return s
}
function integer(v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail()
  return v as number
}
function choice<T extends string>(v: unknown, values: readonly T[]): T {
  if (!values.includes(v as T)) fail()
  return v as T
}
function description(v: unknown): string {
  if (typeof v !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) fail()
  return v as string
}
const reasons: readonly ConnectionEnrollmentReason[] = [
  'adapter-unavailable',
  'secure-storage-unavailable',
  'storage-unconfirmed',
  'begin-unconfirmed',
  'poll-unconfirmed',
  'credential-unconfirmed',
  'configuration-unconfirmed',
  'connection-conflict',
  'authority-unavailable',
  'platform-denied',
  'platform-expired',
  'platform-not-applied'
]
const kinds: readonly ConnectionEnrollmentActionKind[] = [
  'continue-authentication',
  'confirm-account',
  'renew-authentication',
  'create',
  'read-credential',
  'recover-local'
]
export function parseConnectionEnrollmentPreset(value: unknown): ConnectionEnrollmentPreset {
  const p = object(value, ['name', 'description', 'avatar']),
    a = object(p.avatar, ['pngDataUrl'])
  // The existing saved-avatar wire bound, not a platform application limit.
  if (
    typeof a.pngDataUrl !== 'string' ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(a.pngDataUrl) ||
    a.pngDataUrl.length > Math.ceil((512 * 1024) / 3) * 4 + 22 ||
    (a.pngDataUrl.length - 22) % 4
  )
    fail()
  const result = {
    name: text(p.name),
    ...(p.description === undefined ? {} : { description: description(p.description) }),
    avatar: { pngDataUrl: a.pngDataUrl as string }
  }
  summarizeConnectionEnrollmentPreset(result)
  return result
}
export function summarizeConnectionEnrollmentPreset(
  p: ConnectionEnrollmentPreset
): ConnectionEnrollmentPresetSummary {
  let b: Uint8Array
  try {
    b = Uint8Array.from(atob(p.avatar.pngDataUrl.slice(22)), (c) => c.charCodeAt(0))
  } catch {
    return fail()
  }
  if (
    b.length < 33 ||
    [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].some((v, i) => b[i] !== v)
  )
    fail()
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength),
    width = view.getUint32(16),
    height = view.getUint32(20)
  if (!width || !height) fail()
  return {
    name: p.name,
    ...(p.description === undefined ? {} : { description: p.description }),
    avatarSha256: Array.from(sha256(b), (v) => v.toString(16).padStart(2, '0')).join(''),
    width,
    height
  }
}
export function parseConnectionEnrollmentBegin(value: unknown): ConnectionEnrollmentBeginInput {
  const p = object(value, ['operationId', 'connectionId', 'adapterId', 'domain', 'label', 'preset'])
  return {
    operationId: id(p.operationId),
    connectionId: id(p.connectionId),
    adapterId: id(p.adapterId),
    domain: domain(p.domain),
    label: text(p.label),
    preset: parseConnectionEnrollmentPreset(p.preset)
  }
}
export function parseConnectionEnrollmentChallenge(value: unknown): ConnectionEnrollmentChallenge {
  const p = object(value, ['qrPayload', 'expiresAt', 'nextPollAt'])
  return {
    qrPayload: text(p.qrPayload),
    expiresAt: p.expiresAt === null ? null : integer(p.expiresAt, 0),
    nextPollAt: integer(p.nextPollAt, 0)
  }
}
export function parseConnectionEnrollmentAccount(value: unknown): ConnectionEnrollmentAccount {
  const p = object(value, ['userId', 'tenantId', 'userName', 'tenantName'])
  return {
    userId: text(p.userId),
    tenantId: text(p.tenantId),
    ...(p.userName === undefined ? {} : { userName: text(p.userName) }),
    ...(p.tenantName === undefined ? {} : { tenantName: text(p.tenantName) })
  }
}
export function parseConnectionEnrollmentDiagnostic(
  value: unknown
): ConnectionEnrollmentDiagnostic {
  const p = object(value, ['stage', 'code', 'httpStatus', 'step', 'failure', 'nativeCode'])
  if (!['response', 'authentication'].includes(String(p.stage)) && p.httpStatus !== undefined) fail()
  if (p.stage !== 'authentication' && (p.step !== undefined || p.failure !== undefined || p.nativeCode !== undefined)) fail()
  switch (p.stage) {
    case 'request':
      return { stage: p.stage, code: choice(p.code, ['transport-unconfirmed', 'cancelled']) }
    case 'response':
      return {
        stage: p.stage,
        code: choice(p.code, ['http-status', 'platform-error', 'invalid-json', 'invalid-response']),
        ...(p.httpStatus === undefined ? {} : { httpStatus: integer(p.httpStatus, 100, 599) })
      }
    case 'challenge':
      return {
        stage: p.stage,
        code: choice(p.code, ['missing-verification', 'unsafe-verification', 'invalid-challenge'])
      }
    case 'authentication':
      return {
        stage: p.stage, code: choice(p.code, ['native-unconfirmed']),
        ...(p.step === undefined ? {} : { step: choice(p.step, ['initialize', 'poll', 'cross-login', 'landing', 'console', 'account']) }),
        ...(p.failure === undefined ? {} : { failure: choice(p.failure, ['transport-unconfirmed', 'http-status', 'platform-error', 'invalid-response', 'redirect-unconfirmed', 'bootstrap-unconfirmed', 'invalid-state']) }),
        ...(p.httpStatus === undefined ? {} : { httpStatus: integer(p.httpStatus, 100, 599) }),
        ...(p.nativeCode === undefined ? {} : { nativeCode: integer(p.nativeCode, Number.MIN_SAFE_INTEGER) })
      }
    case 'preparation':
      return {
        stage: p.stage,
        code: choice(p.code, [
          'invalid-state',
          'invalid-image',
          'unsupported-domain',
          'invalid-application'
        ])
      }
    case 'adapter':
      return { stage: p.stage, code: choice(p.code, ['receipt-unconfirmed']) }
    case 'journal':
      return { stage: p.stage, code: choice(p.code, ['claim-unconfirmed', 'receipt-unconfirmed']) }
    case 'secure-storage':
      return {
        stage: p.stage,
        code: choice(p.code, [
          'challenge-unconfirmed',
          'credential-unconfirmed',
          'asset-unconfirmed'
        ])
      }
    default:
      return fail()
  }
}
export function parseConnectionEnrollmentOperation(value: unknown): ConnectionEnrollmentOperation {
  const p = object(value, [
    'operationId',
    'connectionId',
    'adapterId',
    'domain',
    'label',
    'preset',
    'revision',
    'authorization',
    'credential',
    'configuration',
    'application',
    'authentication',
    'creation',
    'configured',
    'reason',
    'diagnostic'
  ])
  const app = p.application === null ? null : object(p.application, ['domain', 'appId']),
    application = app ? { domain: domain(app.domain), appId: id(app.appId) } : null
  const preset =
    p.preset === undefined
      ? undefined
      : (() => {
          const v = object(p.preset, ['name', 'description', 'avatarSha256', 'width', 'height'])
          if (v.avatarSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(String(v.avatarSha256)))
            fail()
          if (
            (v.avatarSha256 !== undefined) !== (v.width !== undefined) ||
            (v.width !== undefined) !== (v.height !== undefined)
          )
            fail()
          return {
            name: text(v.name),
            ...(v.description === undefined ? {} : { description: description(v.description) }),
            ...(v.avatarSha256 === undefined
              ? {}
              : {
                  avatarSha256: String(v.avatarSha256),
                  width: integer(v.width, 1),
                  height: integer(v.height, 1)
                })
          }
        })()
  let configured: ConnectionEnrollmentOperation['configured'] = null
  if (p.configured !== null) {
    const c = object(p.configured, ['operationId', 'status', 'connection'])
    if (c.status !== 'configured') fail()
    configured = {
      operationId: id(c.operationId),
      status: 'configured',
      connection: parseConnectionRecord(c.connection)
    }
  }
  const authentication =
    p.authentication === undefined
      ? undefined
      : (() => {
          const a = object(p.authentication, ['attemptId', 'stage'])
          return {
            attemptId: id(a.attemptId),
            stage: choice(a.stage, [
              'not-started',
              'waiting',
              'scanned',
              'handoff',
              'account',
              'confirmed',
              'expired',
              'unknown'
            ] as const)
          }
        })()
  const creation =
    p.creation === undefined
      ? undefined
      : (() => {
          const c = object(p.creation, ['upload', 'create'])
          return {
            upload: choice(c.upload, [
              'not-started',
              'dispatching',
              'confirmed',
              'unknown'
            ] as const),
            create: choice(c.create, [
              'not-started',
              'dispatching',
              'confirmed',
              'unknown'
            ] as const)
          }
        })()
  const result: ConnectionEnrollmentOperation = {
    operationId: id(p.operationId),
    connectionId: id(p.connectionId),
    adapterId: id(p.adapterId),
    domain: domain(p.domain),
    label: text(p.label),
    ...(preset ? { preset } : {}),
    revision: integer(p.revision, 1),
    authorization: choice(p.authorization, [
      'not-started',
      'pending',
      'authorized',
      'denied',
      'expired',
      'unknown'
    ]),
    credential: choice(p.credential, ['not-started', 'storing', 'stored', 'unknown']),
    configuration: choice(p.configuration, [
      'not-started',
      'saving',
      'configured',
      'unknown',
      'refused'
    ]),
    application,
    configured,
    ...(authentication ? { authentication } : {}),
    ...(creation ? { creation } : {}),
    ...(p.reason === undefined ? {} : { reason: choice(p.reason, reasons) }),
    ...(p.diagnostic === undefined
      ? {}
      : { diagnostic: parseConnectionEnrollmentDiagnostic(p.diagnostic) })
  }
  if (application && application.domain !== result.domain) fail()
  if (configured) {
    const c = configured.connection
    if (
      !application ||
      c.revision !== 1 ||
      !c.config.enabled ||
      c.config.connectionId !== result.connectionId ||
      c.config.adapterId !== result.adapterId ||
      c.config.label !== result.label ||
      c.config.application.domain !== application.domain ||
      c.config.application.appId !== application.appId
    )
      fail()
  }
  if (
    (result.configuration === 'configured') !== (configured !== null) ||
    (configured && (result.credential !== 'stored' || result.authorization !== 'authorized')) ||
    (result.authorization === 'authorized' && !application) ||
    (result.credential === 'stored' && !application) ||
    (creation?.create === 'confirmed' && !application)
  )
    fail()
  return result
}
function action(value: unknown): ConnectionEnrollmentAction {
  const p = object(value, ['actionId', 'ownRevision', 'kind'])
  return {
    actionId: id(p.actionId),
    ownRevision: integer(p.ownRevision, 1),
    kind: choice(p.kind, kinds)
  }
}
export function parseConnectionEnrollmentView(value: unknown): ConnectionEnrollmentView {
  const p = object(value, ['operation', 'challenge', 'account', 'actions', 'receipt'])
  if (!Array.isArray(p.actions)) fail()
  const operation = p.operation === null ? null : parseConnectionEnrollmentOperation(p.operation),
    actions = (p.actions as unknown[]).map(action),
    challenge = p.challenge === null ? null : parseConnectionEnrollmentChallenge(p.challenge),
    account = p.account === null ? null : parseConnectionEnrollmentAccount(p.account)
  const receipt =
    p.receipt === undefined
      ? undefined
      : (() => {
          const r = object(p.receipt, ['actionId', 'ownRevision', 'kind', 'stepId', 'state'])
          return {
            ...action({ actionId: r.actionId, ownRevision: r.ownRevision, kind: r.kind }),
            stepId: id(r.stepId),
            state: choice(r.state, ['dispatching', 'confirmed', 'unknown'] as const)
          }
        })()
  if (
    (!operation && (actions.length || challenge || account || receipt)) ||
    (operation && actions.some((a) => a.ownRevision !== operation.revision)) ||
    new Set(actions.map((a) => a.kind)).size !== actions.length ||
    new Set(actions.map((a) => a.actionId)).size !== actions.length ||
    (receipt && operation && receipt.ownRevision > operation.revision)
  )
    fail()
  if ((challenge || account) && !operation?.authentication) fail()
  if (account && !['account', 'confirmed'].includes(operation!.authentication!.stage)) fail()
  return { operation, challenge, account, actions, ...(receipt ? { receipt } : {}) }
}
function capability(value: unknown): ConnectionEnrollmentCapability {
  const p = object(value, ['adapterId', 'domain', 'label', 'availability', 'reason'])
  return {
    adapterId: id(p.adapterId),
    domain: domain(p.domain),
    label: text(p.label),
    availability: choice(p.availability, ['available', 'unavailable', 'unknown']),
    ...(p.reason === undefined
      ? {}
      : { reason: choice(p.reason, ['adapter-unavailable', 'secure-storage-unavailable']) })
  }
}
export function parseConnectionEnrollmentParams<M extends ConnectionEnrollmentMethod>(
  method: M,
  value: unknown
): ConnectionEnrollmentParamsMap[M] {
  if (method === 'connection.enrollment.begin')
    return parseConnectionEnrollmentBegin(value) as ConnectionEnrollmentParamsMap[M]
  if (method === 'connection.enrollment.ls') {
    const p = object(value, ['cursor', 'limit'])
    return {
      ...(p.cursor === undefined ? {} : { cursor: text(p.cursor) }),
      ...(p.limit === undefined ? {} : { limit: integer(p.limit, 1, 100) })
    } as ConnectionEnrollmentParamsMap[M]
  }
  if (method === 'connection.enrollment.advance') {
    const p = object(value, ['operationId', 'ownRevision', 'decision']),
      d = object(p.decision, ['actionId', 'kind'])
    return {
      operationId: id(p.operationId),
      ownRevision: integer(p.ownRevision, 1),
      decision: { actionId: id(d.actionId), kind: choice(d.kind, kinds) }
    } as ConnectionEnrollmentParamsMap[M]
  }
  const p = object(value, ['operationId'])
  return { operationId: id(p.operationId) } as ConnectionEnrollmentParamsMap[M]
}
export function parseConnectionEnrollmentResult<M extends ConnectionEnrollmentMethod>(
  method: M,
  value: unknown,
  input: ConnectionEnrollmentParamsMap[M]
): ConnectionEnrollmentResultMap[M] {
  if (method === 'connection.enrollment.ls') {
    const p = object(value, ['operations', 'next', 'capabilities'])
    if (
      !Array.isArray(p.operations) ||
      !Array.isArray(p.capabilities) ||
      p.operations.length >
        ((input as ConnectionEnrollmentParamsMap['connection.enrollment.ls']).limit ?? 25)
    )
      fail()
    const operations = (p.operations as unknown[]).map(parseConnectionEnrollmentOperation),
      capabilities = (p.capabilities as unknown[]).map(capability)
    if (
      new Set(operations.map((o) => o.operationId)).size !== operations.length ||
      new Set(capabilities.map((c) => JSON.stringify([c.adapterId, c.domain]))).size !==
        capabilities.length
    )
      fail()
    return {
      operations,
      capabilities,
      next: p.next === null ? null : text(p.next)
    } as ConnectionEnrollmentResultMap[M]
  }
  const view = parseConnectionEnrollmentView(value),
    operation = view.operation
  if (
    (operation &&
      operation.operationId !==
        (
          input as {
            operationId: string
          }
        ).operationId) ||
    (!operation && method !== 'connection.enrollment.inspect')
  )
    fail()
  if (operation && method === 'connection.enrollment.begin') {
    const b = input as ConnectionEnrollmentBeginInput
    if (
      operation.connectionId !== b.connectionId ||
      operation.adapterId !== b.adapterId ||
      operation.domain !== b.domain ||
      operation.label !== b.label ||
      JSON.stringify(operation.preset) !==
        JSON.stringify(summarizeConnectionEnrollmentPreset(b.preset))
    )
      fail()
  }
  if (method === 'connection.enrollment.advance' && view.receipt) {
    const a = input as ConnectionEnrollmentParamsMap['connection.enrollment.advance']
    if (
      view.receipt.actionId !== a.decision.actionId ||
      view.receipt.kind !== a.decision.kind ||
      view.receipt.ownRevision !== a.ownRevision
    )
      fail()
  }
  return view as ConnectionEnrollmentResultMap[M]
}
