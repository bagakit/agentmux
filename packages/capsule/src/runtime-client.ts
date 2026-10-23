import { mintObjectId } from '@agentmux/identity'
import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { parseCapsuleParams, parseCapsuleResult } from './parsers.js'
import { CapsuleError } from './storage.js'
import {
  assertCallbackBinding,
  parseCallbackResult,
  parseCapsuleRuntimeIdentity,
  parseRuntimeContext,
  parseRuntimeServerMessage,
  runtimeError,
  RuntimeChannel,
  unknownConnection,
  type CapsuleCallbackMethod,
  type CapsuleRuntimeIdentity,
  type RuntimeServerMessage,
} from './runtime-wire.js'
import type {
  CapsuleCallContext,
  CapsuleMethod,
  CapsuleParamsMap,
  CapsulePort,
  CapsulePresentationPort,
  CapsuleReplyPort,
  CapsuleResultMap,
} from './types.js'

export interface CapsuleRuntimeAdapters {
  presentation?: CapsulePresentationPort
  replies?: CapsuleReplyPort
}
export interface CapsuleRuntimeClient extends CapsulePort {
  identity(): Promise<CapsuleRuntimeIdentity>
  /** Releases this connection only. The independent service and HTTP listeners keep running. */
  dispose(): Promise<void>
}
interface PendingCall {
  method?: CapsuleMethod
  params?: CapsuleParamsMap[CapsuleMethod]
  context?: CapsuleCallContext
  controller: AbortController
  accept(value: unknown): void
  reject(error: unknown): void
}
export async function connectCapsuleRuntime(options: {
  socketPath: string
  expectedRuntimeId?: string
  adapters?: CapsuleRuntimeAdapters
  /** Cancels observation for this connection's entire lifetime, never the serving Run. */
  signal?: AbortSignal
}): Promise<CapsuleRuntimeClient> {
  if (
    typeof options.socketPath !== 'string' ||
    !isAbsolute(options.socketPath) ||
    options.socketPath.includes('\0')
  ) {
    throw new CapsuleError(
      'invalid-params',
      'Connect using the exact absolute private Unix socket address in this Host.',
    )
  }
  if (options.signal?.aborted) {
    throw new CapsuleError(
      'CAPSULE_CALL_CANCELLED',
      'The runtime connection was cancelled before opening a socket.',
    )
  }
  const socket = createConnection(options.socketPath)
  const calls = new Map<string, PendingCall>()
  const retiredCalls = new Set<string>()
  const callbacks = new Map<string, { callId: string; controller: AbortController }>()
  const seenCallbacks = new Set<string>()
  let closed = false
  const fail = (error: unknown) => {
    if (closed) return
    closed = true
    options.signal?.removeEventListener('abort', abortedConnection)
    for (const call of [...calls.values()]) call.reject(error)
    for (const callback of callbacks.values()) callback.controller.abort()
    socket.destroy()
  }
  const channel = new RuntimeChannel(
    socket,
    (value) => receive(parseRuntimeServerMessage(value)),
    fail,
  )
  const abortedConnection = () => fail(unknownConnection())
  options.signal?.addEventListener('abort', abortedConnection, { once: true })
  function receive(message: RuntimeServerMessage): void {
    if (message.kind === 'result') {
      const call = calls.get(message.id)
      if (!call) {
        if (retiredCalls.has(message.id)) return
        throw new CapsuleError(
          'CAPSULE_RUNTIME_PROTOCOL_INVALID',
          'The result has no original pending request on this connection.',
        )
      }
      if (message.ok) call.accept(message.value)
      else call.reject(new CapsuleError(message.error.code, message.error.message))
      return
    }
    if (message.kind === 'callback.cancel') {
      const callback = callbacks.get(message.id)
      if (callback && callback.callId !== message.callId) {
        throw new CapsuleError(
          'CAPSULE_RUNTIME_PROTOCOL_INVALID',
          'The cancellation does not belong to this callback call.',
        )
      }
      callback?.controller.abort()
      return
    }
    if (seenCallbacks.has(message.id))
      throw new CapsuleError(
        'CAPSULE_RUNTIME_PROTOCOL_INVALID',
        'A callback identity cannot be replayed.',
      )
    seenCallbacks.add(message.id)
    const call = calls.get(message.callId)
    if (!call || !call.method || !call.params || call.controller.signal.aborted) {
      if (retiredCalls.has(message.callId)) {
        channel.send({
          version: 1,
          kind: 'callback.result',
          callId: message.callId,
          id: message.id,
          ok: false,
          error: runtimeError(unknownConnection()),
        })
        return
      }
      throw new CapsuleError(
        'CAPSULE_RUNTIME_PROTOCOL_INVALID',
        'The callback has no original pending call on this connection.',
      )
    }
    assertCallbackBinding(message.method, message.input, call.method, call.params)
    const controller = new AbortController()
    callbacks.set(message.id, { callId: message.callId, controller })
    const signal = AbortSignal.any([call.controller.signal, controller.signal])
    const context: CapsuleCallContext = { ...call.context, signal }
    void invokeAdapter(message.method, message.input, context)
      .then(
        (value) =>
          replyCallback(message, {
            ok: true,
            value: parseCallbackResult(message.method, value, message.input),
          }),
        (error) => replyCallback(message, { ok: false, error: runtimeError(error) }),
      )
      .catch((error) => replyCallback(message, { ok: false, error: runtimeError(error) }))
  }
  function replyCallback(
    message: Extract<RuntimeServerMessage, { kind: 'callback' }>,
    outcome: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
  ): void {
    const callback = callbacks.get(message.id)
    callbacks.delete(message.id)
    if (closed || !callback || callback.controller.signal.aborted) return
    try {
      channel.send({
        version: 1,
        kind: 'callback.result',
        callId: message.callId,
        id: message.id,
        ...outcome,
      })
    } catch (error) {
      fail(error)
    }
  }
  async function invokeAdapter(
    method: CapsuleCallbackMethod,
    input: unknown,
    context: CapsuleCallContext,
  ): Promise<unknown> {
    const adapters = options.adapters
    switch (method) {
      case 'presentation.open': {
        if (!adapters?.presentation) break
        const value = input as {
          params: CapsuleParamsMap['capsule.open']
          resolved: CapsuleResultMap['capsule.resolve']
        }
        return adapters.presentation.open(value.params, context, value.resolved)
      }
      case 'presentation.inspect': {
        if (!adapters?.presentation?.inspect) break
        return adapters.presentation.inspect(
          (input as { params: CapsuleParamsMap['capsule.open'] }).params,
          context,
        )
      }
      case 'replies.prepare':
        if (!adapters?.replies) break
        return adapters.replies.prepare(
          input as Parameters<CapsuleReplyPort['prepare']>[0],
          context,
        )
      case 'replies.submit':
        if (!adapters?.replies) break
        return adapters.replies.submit(input as Parameters<CapsuleReplyPort['submit']>[0], context)
      case 'replies.inspect':
        if (!adapters?.replies) break
        return adapters.replies.inspect(
          input as Parameters<CapsuleReplyPort['inspect']>[0],
          context,
        )
    }
    throw new CapsuleError(
      'CAPSULE_ADAPTER_UNAVAILABLE',
      'This exact client does not provide the requested adapter.',
    )
  }
  function request(
    send: (id: string) => void,
    original?: {
      method: CapsuleMethod
      params: CapsuleParamsMap[CapsuleMethod]
      context?: CapsuleCallContext
    },
  ): Promise<unknown> {
    if (closed) return Promise.reject(unknownConnection())
    if (original?.context?.signal?.aborted) {
      return Promise.reject(
        new CapsuleError(
          'CAPSULE_CALL_CANCELLED',
          'The original call was cancelled before any runtime frame was sent.',
        ),
      )
    }
    const id = mintObjectId()
    return new Promise((accept, reject) => {
      const controller = new AbortController()
      const externalSignal = original?.context?.signal
      const dispose = () => {
        calls.delete(id)
        retiredCalls.add(id)
        externalSignal?.removeEventListener('abort', aborted)
        controller.abort()
        for (const [callbackId, callback] of callbacks) {
          if (callback.callId === id) {
            callback.controller.abort()
            callbacks.delete(callbackId)
          }
        }
      }
      const aborted = () => {
        dispose()
        reject(unknownConnection())
        try {
          channel.send({ version: 1, kind: 'cancel', id })
        } catch (error) {
          fail(error)
        }
      }
      calls.set(id, {
        ...(original ? { method: original.method, params: original.params } : {}),
        ...(original?.context ? { context: original.context } : {}),
        controller,
        accept(value) {
          dispose()
          accept(value)
        },
        reject(error) {
          dispose()
          reject(error)
        },
      })
      externalSignal?.addEventListener('abort', aborted, { once: true })
      try {
        send(id)
      } catch (error) {
        dispose()
        reject(error)
      }
    })
  }
  try {
    await new Promise<void>((accept, reject) => {
      socket.once('connect', accept)
      socket.once('error', reject)
      socket.once('close', () => reject(unknownConnection()))
    })
    const supported: CapsuleCallbackMethod[] = []
    if (options.adapters?.presentation) supported.push('presentation.open')
    if (options.adapters?.presentation?.inspect) supported.push('presentation.inspect')
    if (options.adapters?.replies)
      supported.push('replies.prepare', 'replies.submit', 'replies.inspect')
    const identity = parseCapsuleRuntimeIdentity(
      await request((id) => {
        channel.send({ version: 1, kind: 'hello', id, callbacks: supported })
      }),
    )
    if (
      options.expectedRuntimeId !== undefined &&
      options.expectedRuntimeId !== identity.runtimeId
    ) {
      throw new CapsuleError(
        'CAPSULE_RUNTIME_IDENTITY_MISMATCH',
        'The exact socket belongs to a different Capsule domain. No business call was sent.',
      )
    }
    return {
      async identity() {
        const observed = parseCapsuleRuntimeIdentity(
          await request((id) => channel.send({ version: 1, kind: 'identity', id })),
        )
        if (
          observed.runtimeId !== identity.runtimeId ||
          observed.ownerInstanceId !== identity.ownerInstanceId
        ) {
          fail(
            new CapsuleError(
              'CAPSULE_RUNTIME_IDENTITY_MISMATCH',
              'The connection no longer observes its original runtime owner.',
            ),
          )
          throw new CapsuleError(
            'CAPSULE_RUNTIME_IDENTITY_MISMATCH',
            'The connection no longer observes its original runtime owner.',
          )
        }
        return observed
      },
      async call<M extends CapsuleMethod>(
        method: M,
        value: CapsuleParamsMap[M],
        context?: CapsuleCallContext,
      ): Promise<CapsuleResultMap[M]> {
        const params = parseCapsuleParams(method, value)
        const attribution = context
          ? parseRuntimeContext({
              ...(context.caller ? { caller: context.caller } : {}),
              ...(context.principal ? { principal: context.principal } : {}),
            })
          : undefined
        const originalContext: CapsuleCallContext | undefined = context
          ? {
              ...attribution,
              ...(context.signal ? { signal: context.signal } : {}),
            }
          : undefined
        const result = await request(
          (id) =>
            channel.send({
              version: 1,
              kind: 'call',
              id,
              method,
              params,
              ...(attribution ? { context: attribution } : {}),
            }),
          { method, params, ...(originalContext ? { context: originalContext } : {}) },
        )
        return parseCapsuleResult(method, result, params)
      },
      async dispose() {
        // Connection ownership ends here; no stop or replay command is sent to the service.
        fail(unknownConnection())
      },
    }
  } catch (error) {
    fail(error)
    throw error
  }
}
