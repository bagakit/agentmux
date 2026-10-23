import { isObjectId } from '@agentmux/identity'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Socket } from 'node:net'
import {
  isCapsuleMethod,
  parseCapsuleInputObservation,
  parseCapsuleInteraction,
  parseCapsuleParams,
  parseCapsulePreparedReply,
  parseCapsuleResult,
} from './parsers.js'
import { CapsuleError } from './storage.js'
import type { CapsuleCallContext, CapsuleMethod, CapsuleParamsMap } from './types.js'

/** A per-frame transport bound, not a domain draft/content limit. */
export const CAPSULE_RUNTIME_MAX_FRAME_BYTES = 16 * 1024 * 1024
export const CAPSULE_CALLBACK_METHODS = [
  'presentation.open',
  'presentation.inspect',
  'replies.prepare',
  'replies.submit',
  'replies.inspect',
] as const
export type CapsuleCallbackMethod = (typeof CAPSULE_CALLBACK_METHODS)[number]
export interface CapsuleRuntimeIdentity {
  runtimeId: string
  ownerInstanceId: string
  pid: number
  stateDirectory: string
}
export type RuntimeContext = Omit<CapsuleCallContext, 'signal'>
export type RuntimeError = { code: string; message: string }
export type RuntimeOutcome = { ok: true; value: unknown } | { ok: false; error: RuntimeError }
export type RuntimeClientMessage =
  | { version: 1; kind: 'hello'; id: string; callbacks: CapsuleCallbackMethod[] }
  | { version: 1; kind: 'identity'; id: string }
  | {
      version: 1
      kind: 'call'
      id: string
      method: CapsuleMethod
      params: unknown
      context?: RuntimeContext
    }
  | { version: 1; kind: 'cancel'; id: string }
  | ({ version: 1; kind: 'callback.result'; id: string; callId: string } & RuntimeOutcome)
export type RuntimeServerMessage =
  | ({ version: 1; kind: 'result'; id: string } & RuntimeOutcome)
  | {
      version: 1
      kind: 'callback'
      id: string
      callId: string
      method: CapsuleCallbackMethod
      input: unknown
    }
  | { version: 1; kind: 'callback.cancel'; id: string; callId: string }

function invalid(at: string): never {
  throw new CapsuleError(
    'CAPSULE_RUNTIME_PROTOCOL_INVALID',
    `Invalid Capsule runtime protocol at ${at}.`,
  )
}
function object(value: unknown, keys: string[], at: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(at)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid(at)
  return record
}
function text(value: unknown, at: string, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0')) invalid(at)
}
function id(value: unknown, at: string): asserts value is string {
  if (!isObjectId(value)) invalid(at)
}
/** Reject values JSON would silently change before a possibly executing write. */
function json(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object' || seen.has(value)) invalid('json')
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) json(item, seen)
  } else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('json')
    for (const item of Object.values(value)) json(item, seen)
  }
  seen.delete(value)
}
export function parseRuntimeContext(value: unknown): RuntimeContext {
  const record = object(value, ['caller', 'principal'], 'context')
  if (Object.hasOwn(record, 'caller')) {
    const caller = object(record.caller, ['hostId', 'agentSessionId'], 'context.caller')
    text(caller.hostId, 'context.caller.hostId')
    if (Object.hasOwn(caller, 'agentSessionId'))
      text(caller.agentSessionId, 'context.caller.agentSessionId')
  }
  if (Object.hasOwn(record, 'principal')) {
    const principal = object(record.principal, ['kind', 'id'], 'context.principal')
    if (principal.kind !== 'user' && principal.kind !== 'device') invalid('context.principal.kind')
    text(principal.id, 'context.principal.id')
  }
  return structuredClone(record) as RuntimeContext
}
export function parseCapsuleRuntimeIdentity(value: unknown): CapsuleRuntimeIdentity {
  const record = object(
    value,
    ['runtimeId', 'ownerInstanceId', 'pid', 'stateDirectory'],
    'identity',
  )
  id(record.runtimeId, 'identity.runtimeId')
  id(record.ownerInstanceId, 'identity.ownerInstanceId')
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1) invalid('identity.pid')
  text(record.stateDirectory, 'identity.stateDirectory')
  if (!isAbsolute(record.stateDirectory)) invalid('identity.stateDirectory')
  return structuredClone(record) as unknown as CapsuleRuntimeIdentity
}
function outcome(record: Record<string, unknown>): void {
  if (record.ok === true) {
    if (!Object.hasOwn(record, 'value') || Object.hasOwn(record, 'error')) invalid('result.value')
    json(record.value)
  } else if (record.ok === false) {
    if (Object.hasOwn(record, 'value')) invalid('result.error')
    const error = object(record.error, ['code', 'message'], 'result.error')
    text(error.code, 'result.error.code')
    text(error.message, 'result.error.message')
  } else invalid('result.ok')
}
function envelope(value: unknown): Record<string, unknown> {
  const record = object(
    value,
    [
      'version',
      'kind',
      'id',
      'callId',
      'callbacks',
      'method',
      'params',
      'context',
      'ok',
      'value',
      'error',
      'input',
    ],
    'message',
  )
  if (record.version !== 1) invalid('version')
  id(record.id, 'id')
  return record
}
export function parseRuntimeClientMessage(value: unknown): RuntimeClientMessage {
  const record = envelope(value)
  switch (record.kind) {
    case 'hello':
      object(value, ['version', 'kind', 'id', 'callbacks'], 'hello')
      if (
        !Array.isArray(record.callbacks) ||
        new Set(record.callbacks).size !== record.callbacks.length ||
        record.callbacks.some((method) => !CAPSULE_CALLBACK_METHODS.includes(method))
      )
        invalid('callbacks')
      break
    case 'call':
      object(value, ['version', 'kind', 'id', 'method', 'params', 'context'], 'call')
      if (!isCapsuleMethod(record.method)) invalid('method')
      parseCapsuleParams(record.method, record.params)
      json(record.params)
      if (Object.hasOwn(record, 'context')) parseRuntimeContext(record.context)
      break
    case 'cancel':
    case 'identity':
      object(value, ['version', 'kind', 'id'], 'cancel')
      break
    case 'callback.result':
      object(value, ['version', 'kind', 'id', 'callId', 'ok', 'value', 'error'], 'callback.result')
      id(record.callId, 'callId')
      outcome(record)
      break
    default:
      invalid('kind')
  }
  return structuredClone(record) as unknown as RuntimeClientMessage
}
export function parseRuntimeServerMessage(value: unknown): RuntimeServerMessage {
  const record = envelope(value)
  switch (record.kind) {
    case 'result':
      object(value, ['version', 'kind', 'id', 'ok', 'value', 'error'], 'result')
      outcome(record)
      break
    case 'callback':
      object(value, ['version', 'kind', 'id', 'callId', 'method', 'input'], 'callback')
      id(record.callId, 'callId')
      if (!CAPSULE_CALLBACK_METHODS.includes(record.method as CapsuleCallbackMethod))
        invalid('callback.method')
      parseCallbackInput(record.method as CapsuleCallbackMethod, record.input)
      break
    case 'callback.cancel':
      object(value, ['version', 'kind', 'id', 'callId'], 'callback.cancel')
      id(record.callId, 'callId')
      break
    default:
      invalid('kind')
  }
  return structuredClone(record) as unknown as RuntimeServerMessage
}
export function parseCallbackInput(method: CapsuleCallbackMethod, value: unknown): unknown {
  switch (method) {
    case 'presentation.open': {
      const input = object(value, ['params', 'resolved'], 'presentation.open')
      const params = parseCapsuleParams('capsule.open', input.params)
      parseCapsuleResult('capsule.resolve', input.resolved, { capsuleId: params.capsuleId })
      break
    }
    case 'presentation.inspect': {
      const input = object(value, ['params'], 'presentation.inspect')
      parseCapsuleParams('capsule.open', input.params)
      break
    }
    case 'replies.prepare': {
      const input = object(
        value,
        ['interaction', 'answer', 'inputOperationId', 'operationId'],
        'replies.prepare',
      )
      const interaction = parseCapsuleInteraction(input.interaction)
      parseCapsuleParams('capsule.interaction.reply', {
        capsuleId: interaction.capsuleId,
        interactionId: interaction.interactionId,
        expectedRevision: interaction.revision,
        operationId: input.operationId,
        answer: input.answer,
      })
      id(input.inputOperationId, 'replies.prepare.inputOperationId')
      break
    }
    case 'replies.submit':
    case 'replies.inspect':
      parseCapsulePreparedReply(value)
      break
  }
  json(value)
  return structuredClone(value)
}
export function parseCallbackResult(
  method: CapsuleCallbackMethod,
  value: unknown,
  input: unknown,
): unknown {
  switch (method) {
    case 'presentation.open':
    case 'presentation.inspect':
      return method === 'presentation.inspect' && value === null
        ? null
        : parseCapsuleResult(
            'capsule.open',
            value,
            (input as { params: CapsuleParamsMap['capsule.open'] }).params,
          )
    case 'replies.prepare':
      return parseCapsulePreparedReply(value)
    case 'replies.submit':
    case 'replies.inspect':
      return method === 'replies.inspect' && value === null
        ? null
        : parseCapsuleInputObservation(value)
  }
}
/** A callback can consume only the original pending call, never another call's authority. */
export function assertCallbackBinding(
  method: CapsuleCallbackMethod,
  input: unknown,
  originalMethod: CapsuleMethod,
  originalParams: CapsuleParamsMap[CapsuleMethod],
): void {
  const original = originalParams as {
    operationId?: string
    capsuleId?: string
    interactionId?: string
    answer?: string
    expectedRevision?: number
  }
  const callback = input as {
    params?: CapsuleParamsMap['capsule.open']
    operationId?: string
    capsuleId?: string
    interactionId?: string
    answer?: string
    interaction?: { capsuleId: string; interactionId: string; revision: number }
  }
  if (method === 'presentation.open' || method === 'presentation.inspect') {
    if (method === 'presentation.open' && originalMethod !== 'capsule.open')
      invalid('callback.binding')
    if (originalMethod === 'capsule.open' && isDeepStrictEqual(originalParams, callback.params))
      return
    if (
      method === 'presentation.inspect' &&
      originalMethod === 'capsule.operation.inspect' &&
      callback.params?.operationId === original.operationId
    )
      return
  } else {
    if (
      method === 'replies.inspect' &&
      originalMethod === 'capsule.interaction.inspect' &&
      callback.capsuleId === original.capsuleId &&
      callback.interactionId === original.interactionId
    )
      return
    if (
      method === 'replies.inspect' &&
      originalMethod === 'capsule.operation.inspect' &&
      callback.operationId === original.operationId
    )
      return
    if (
      originalMethod === 'capsule.interaction.reply' &&
      callback.operationId === original.operationId
    ) {
      if (
        method === 'replies.prepare' &&
        callback.interaction &&
        callback.interaction.capsuleId === original.capsuleId &&
        callback.interaction.interactionId === original.interactionId &&
        callback.answer === original.answer &&
        callback.interaction.revision === original.expectedRevision
      )
        return
      if (
        method !== 'replies.prepare' &&
        callback.capsuleId === original.capsuleId &&
        callback.interactionId === original.interactionId
      )
        return
    }
  }
  invalid('callback.binding')
}
export function runtimeError(error: unknown): RuntimeError {
  return {
    code:
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'CAPSULE_RUNTIME_FAILURE',
    message:
      error instanceof Error && error.message ? error.message : 'The Capsule runtime call failed.',
  }
}
export function unknownConnection(): CapsuleError {
  return new CapsuleError(
    'CAPSULE_OPERATION_UNKNOWN',
    'The original Capsule runtime observation ended without confirmation. Inspect its original operation; do not replay it.',
  )
}
/** Length-prefixed JSON allows split UTF-8 and multiple frames without unbounded buffering. */
export class RuntimeChannel {
  private header = Buffer.alloc(0)
  private body = Buffer.alloc(0)
  private length = 0
  constructor(
    readonly socket: Socket,
    onMessage: (value: unknown) => void,
    onFailure: (error: unknown) => void,
  ) {
    socket.on('data', (chunk: Buffer) => {
      try {
        let offset = 0
        while (offset < chunk.length) {
          if (this.header.length < 4) {
            const take = Math.min(4 - this.header.length, chunk.length - offset)
            this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + take)])
            offset += take
            if (this.header.length < 4) continue
            this.length = this.header.readUInt32BE()
            if (!this.length || this.length > CAPSULE_RUNTIME_MAX_FRAME_BYTES)
              invalid('frame.length')
            this.body = Buffer.allocUnsafe(this.length)
          }
          const take = Math.min(this.length - this.bodyOffset, chunk.length - offset)
          chunk.copy(this.body, this.bodyOffset, offset, offset + take)
          this.bodyOffset += take
          offset += take
          if (this.bodyOffset === this.length) {
            const value: unknown = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(this.body),
            )
            this.header = Buffer.alloc(0)
            this.body = Buffer.alloc(0)
            this.bodyOffset = 0
            onMessage(value)
          }
        }
      } catch (error) {
        onFailure(error)
        socket.destroy()
      }
    })
    socket.on('error', onFailure)
    socket.on('close', () => onFailure(unknownConnection()))
  }
  private bodyOffset = 0
  send(value: RuntimeClientMessage | RuntimeServerMessage): void {
    json(value)
    const body = Buffer.from(JSON.stringify(value))
    if (!body.length || body.length > CAPSULE_RUNTIME_MAX_FRAME_BYTES) {
      throw new CapsuleError(
        'CAPSULE_RUNTIME_FRAME_TOO_LARGE',
        'The encoded Capsule runtime frame exceeds the transport byte limit. No frame was sent.',
      )
    }
    if (this.socket.destroyed) throw unknownConnection()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    this.socket.write(Buffer.concat([header, body]))
  }
}
