import { mintObjectId, isObjectId } from '@agentmux/identity'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, createConnection, type Socket } from 'node:net'
import { lstat, chmod, mkdir, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { NodeCapsuleOwner } from './node.js'
import { CapsuleError, errorCode, readOptional, writeJson } from './storage.js'
import {
  parseCallbackInput,
  parseCallbackResult,
  parseRuntimeClientMessage,
  runtimeError,
  RuntimeChannel,
  unknownConnection,
  type CapsuleCallbackMethod,
  type CapsuleRuntimeIdentity,
  type RuntimeClientMessage,
} from './runtime-wire.js'
import type { CapsuleCallContext, CapsuleReplyPort, CapsulePresentationPort } from './types.js'

export interface CapsuleRuntimeServer {
  identity(): Promise<CapsuleRuntimeIdentity>
  close(): Promise<void>
}
interface RuntimeCall {
  connection: RuntimeConnection
  id: string
  controller: AbortController
}
interface PendingCallback {
  callId: string
  method: CapsuleCallbackMethod
  input: unknown
  accept(value: unknown): void
  reject(error: unknown): void
  dispose(): void
}
class RuntimeConnection {
  readonly calls = new Map<string, RuntimeCall>()
  readonly callbacks = new Set<CapsuleCallbackMethod>()
  private readonly seenRequests = new Set<string>()
  private readonly pendingCallbacks = new Map<string, PendingCallback>()
  private readonly retiredCallbacks = new Map<string, string>()
  private readonly channel: RuntimeChannel
  private ready = false
  private closed = false
  constructor(
    readonly socket: Socket,
    private readonly identity: CapsuleRuntimeIdentity,
    private readonly owner: NodeCapsuleOwner,
    private readonly scope: AsyncLocalStorage<RuntimeCall>,
  ) {
    this.channel = new RuntimeChannel(
      socket,
      (value) => this.receive(parseRuntimeClientMessage(value)),
      () => this.disconnect(),
    )
  }
  disconnect(): void {
    if (this.closed) return
    this.closed = true
    for (const call of this.calls.values()) call.controller.abort()
    for (const callback of [...this.pendingCallbacks.values()]) callback.reject(unknownConnection())
    this.socket.destroy()
  }
  private receive(message: RuntimeClientMessage): void {
    if (message.kind === 'callback.result') {
      const callback = this.pendingCallbacks.get(message.id)
      if (!callback) {
        if (this.retiredCallbacks.get(message.id) === message.callId) return
        throw new CapsuleError(
          'CAPSULE_RUNTIME_PROTOCOL_INVALID',
          'The callback does not belong to this original connection.',
        )
      }
      if (callback.callId !== message.callId) {
        throw new CapsuleError(
          'CAPSULE_RUNTIME_PROTOCOL_INVALID',
          'The callback belongs to a different original call.',
        )
      }
      if (!message.ok) callback.reject(new CapsuleError(message.error.code, message.error.message))
      else {
        try {
          callback.accept(parseCallbackResult(callback.method, message.value, callback.input))
        } catch (error) {
          callback.reject(error)
        }
      }
      return
    }
    if (message.kind === 'cancel') {
      this.calls.get(message.id)?.controller.abort()
      return
    }
    if (this.seenRequests.has(message.id)) {
      throw new CapsuleError(
        'CAPSULE_RUNTIME_PROTOCOL_INVALID',
        'A runtime request identity cannot be reused on this connection.',
      )
    }
    this.seenRequests.add(message.id)
    if (message.kind === 'hello') {
      if (this.ready)
        throw new CapsuleError(
          'CAPSULE_RUNTIME_PROTOCOL_INVALID',
          'This runtime connection is already initialized.',
        )
      this.ready = true
      for (const method of message.callbacks) this.callbacks.add(method)
      this.channel.send({
        version: 1,
        kind: 'result',
        id: message.id,
        ok: true,
        value: this.identity,
      })
      return
    }
    if (!this.ready)
      throw new CapsuleError(
        'CAPSULE_RUNTIME_PROTOCOL_INVALID',
        'Initialize this exact runtime connection before calling it.',
      )
    if (message.kind === 'identity') {
      this.channel.send({
        version: 1,
        kind: 'result',
        id: message.id,
        ok: true,
        value: this.identity,
      })
      return
    }
    const call: RuntimeCall = {
      connection: this,
      id: message.id,
      controller: new AbortController(),
    }
    this.calls.set(call.id, call)
    // Invocation scope remains with queued work and callbacks, never a mutable last-client slot.
    const work = this.scope.run(call, async () => {
      if (
        message.method === 'capsule.interaction.reply' &&
        !this.callbacks.has('replies.prepare')
      ) {
        throw new CapsuleError(
          'CAPSULE_TRUSTED_REPLY_UNAVAILABLE',
          'This original client has no trusted input adapter. Attribution data does not authenticate Human input.',
        )
      }
      return this.owner.call(message.method, message.params as never, {
        ...message.context,
        signal: call.controller.signal,
      })
    })
    void work.then(
      (value) => this.finish(call, { ok: true, value }),
      (error) => this.finish(call, { ok: false, error: runtimeError(error) }),
    )
  }
  private finish(
    call: RuntimeCall,
    outcome: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
  ): void {
    this.calls.delete(call.id)
    call.controller.abort()
    if (this.closed) return
    try {
      this.channel.send({ version: 1, kind: 'result', id: call.id, ...outcome })
    } catch (error) {
      // A result too large to transport is a failed observation of the original effect.
      try {
        this.channel.send({
          version: 1,
          kind: 'result',
          id: call.id,
          ok: false,
          error:
            errorCode(error) === 'CAPSULE_RUNTIME_FRAME_TOO_LARGE'
              ? {
                  code: 'CAPSULE_OPERATION_UNKNOWN',
                  message:
                    'The original operation result exceeds this transport frame budget. Its effect is retained; inspect the original operation without replaying it. Other pages and connections remain available.',
                }
              : runtimeError(error),
        })
      } catch {
        this.disconnect()
      }
    }
  }
  callback(
    call: RuntimeCall,
    method: CapsuleCallbackMethod,
    input: unknown,
    context?: CapsuleCallContext,
  ): Promise<unknown> {
    if (!this.callbacks.has(method)) {
      return Promise.reject(
        new CapsuleError(
          'CAPSULE_ADAPTER_UNAVAILABLE',
          'This original runtime client does not provide the requested adapter.',
        ),
      )
    }
    const signal = context?.signal
      ? AbortSignal.any([call.controller.signal, context.signal])
      : call.controller.signal
    if (this.closed || signal.aborted) return Promise.reject(unknownConnection())
    const id = mintObjectId()
    const parsed = parseCallbackInput(method, input)
    return new Promise((accept, reject) => {
      const dispose = () => {
        signal.removeEventListener('abort', aborted)
        this.pendingCallbacks.delete(id)
        this.retiredCallbacks.set(id, call.id)
      }
      const aborted = () => {
        dispose()
        reject(unknownConnection())
        if (!this.closed) {
          try {
            this.channel.send({ version: 1, kind: 'callback.cancel', id, callId: call.id })
          } catch {
            this.disconnect()
          }
        }
      }
      this.pendingCallbacks.set(id, {
        callId: call.id,
        method,
        input: parsed,
        dispose,
        accept(value) {
          dispose()
          accept(value)
        },
        reject(error) {
          dispose()
          reject(error)
        },
      })
      signal.addEventListener('abort', aborted, { once: true })
      try {
        this.channel.send({
          version: 1,
          kind: 'callback',
          id,
          callId: call.id,
          method,
          input: parsed,
        })
      } catch (error) {
        dispose()
        reject(error)
      }
    })
  }
}
function currentCall(scope: AsyncLocalStorage<RuntimeCall>): RuntimeCall {
  const call = scope.getStore()
  if (!call)
    throw new CapsuleError(
      'CAPSULE_ADAPTER_UNAVAILABLE',
      'No original client call is observing this adapter operation.',
    )
  return call
}
function adapters(scope: AsyncLocalStorage<RuntimeCall>): {
  presentation: CapsulePresentationPort
  replies: CapsuleReplyPort
} {
  const invoke = (method: CapsuleCallbackMethod, input: unknown, context?: CapsuleCallContext) => {
    const call = currentCall(scope)
    return call.connection.callback(call, method, input, context)
  }
  return {
    presentation: {
      async open(params, context, resolved) {
        const call = currentCall(scope)
        if (!call.connection.callbacks.has('presentation.open')) {
          return {
            operationId: params.operationId,
            capsuleId: params.capsuleId,
            endpoint: resolved.endpoint,
            rendering: {
              status: 'unavailable',
              reason:
                'This original client has no Browser presentation adapter. The independent Capsule HTTP endpoint remains available.',
            },
          }
        }
        return (await invoke('presentation.open', { params, resolved }, context)) as Awaited<
          ReturnType<CapsulePresentationPort['open']>
        >
      },
      async inspect(params, context) {
        const call = currentCall(scope)
        if (!call.connection.callbacks.has('presentation.inspect')) return null
        return (await invoke('presentation.inspect', { params }, context)) as Awaited<
          ReturnType<NonNullable<CapsulePresentationPort['inspect']>>
        >
      },
    },
    replies: {
      async prepare(input, context) {
        return (await invoke('replies.prepare', input, context)) as Awaited<
          ReturnType<CapsuleReplyPort['prepare']>
        >
      },
      async submit(input, context) {
        return (await invoke('replies.submit', input, context)) as Awaited<
          ReturnType<CapsuleReplyPort['submit']>
        >
      },
      async inspect(input, context) {
        const call = currentCall(scope)
        if (!call.connection.callbacks.has('replies.inspect')) return null
        return (await invoke('replies.inspect', input, context)) as Awaited<
          ReturnType<CapsuleReplyPort['inspect']>
        >
      },
    },
  }
}
/** Unix paths are interpreted only in the serving Host's filesystem namespace. */
export function runtimeAbsolutePath(value: string): void {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new CapsuleError(
      'invalid-params',
      'Capsule runtime paths must be explicit absolute paths in the serving Host.',
    )
  }
}
async function socketBoundary(socketPath: string): Promise<string> {
  runtimeAbsolutePath(socketPath)
  if (process.platform === 'win32')
    throw new CapsuleError(
      'CAPSULE_RUNTIME_UNSUPPORTED',
      'This runtime transport requires a private Unix socket.',
    )
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  const parent = await lstat(dirname(socketPath))
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  ) {
    throw new CapsuleError(
      'CAPSULE_RUNTIME_SOCKET_UNSAFE',
      'The socket parent must be a private real directory owned by the serving user.',
    )
  }
  const canonical = join(await realpath(dirname(socketPath)), basename(socketPath))
  const limit = process.platform === 'darwin' ? 103 : 107
  if (Buffer.byteLength(canonical) > limit)
    throw new CapsuleError(
      'CAPSULE_RUNTIME_SOCKET_PATH_TOO_LONG',
      'The private socket path exceeds the Unix transport path limit.',
    )
  return canonical
}
async function removeStaleSocket(socketPath: string): Promise<void> {
  const original = await lstat(socketPath).catch((error) => {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  })
  if (!original) return
  if (!original.isSocket() || original.uid !== process.getuid?.()) {
    throw new CapsuleError(
      'CAPSULE_RUNTIME_SOCKET_UNSAFE',
      'The exact socket address is occupied by another filesystem object. It has been retained.',
    )
  }
  const status = await new Promise<'live' | 'stale'>((accept, reject) => {
    const probe = createConnection(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      accept('live')
    })
    probe.once('error', (error) => {
      probe.destroy()
      if (errorCode(error) === 'ECONNREFUSED') accept('stale')
      else reject(error)
    })
  })
  if (status === 'live')
    throw new CapsuleError(
      'CAPSULE_RUNTIME_SOCKET_BUSY',
      'The exact socket still has a live listener. It has not been replaced.',
    )
  const current = await lstat(socketPath)
  if (current.dev !== original.dev || current.ino !== original.ino || !current.isSocket()) {
    throw new CapsuleError(
      'CAPSULE_RUNTIME_SOCKET_UNCONFIRMED',
      'The socket identity changed during observation. It has not been removed.',
    )
  }
  await unlink(socketPath)
}
export async function startCapsuleRuntime(options: {
  stateDirectory: string
  socketPath: string
}): Promise<CapsuleRuntimeServer> {
  runtimeAbsolutePath(options.stateDirectory)
  const socketPath = await socketBoundary(options.socketPath)
  await removeStaleSocket(socketPath)
  const scope = new AsyncLocalStorage<RuntimeCall>()
  const owner = await NodeCapsuleOwner.open({
    stateDirectory: options.stateDirectory,
    ...adapters(scope),
  })
  const connections = new Set<RuntimeConnection>()
  const server = createServer((socket) => {
    const connection = new RuntimeConnection(socket, identity, owner, scope)
    connections.add(connection)
    socket.once('close', () => connections.delete(connection))
  })
  let identity: CapsuleRuntimeIdentity
  let socketIdentity: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    const stateDirectory = await realpath(options.stateDirectory)
    const path = join(stateDirectory, 'runtime.json')
    const saved = await readOptional(path)
    let runtimeId: string
    if (saved === null) {
      runtimeId = mintObjectId()
      await writeJson(path, { schemaVersion: 1, runtimeId })
    } else {
      if (
        !saved ||
        typeof saved !== 'object' ||
        Array.isArray(saved) ||
        Object.keys(saved).some((key) => key !== 'schemaVersion' && key !== 'runtimeId') ||
        (saved as { schemaVersion?: unknown }).schemaVersion !== 1 ||
        !isObjectId((saved as { runtimeId?: unknown }).runtimeId)
      ) {
        throw new CapsuleError(
          'CAPSULE_RUNTIME_IDENTITY_UNCONFIRMED',
          'The original runtime identity cannot be read. It has not been replaced or reminted.',
        )
      }
      runtimeId = (saved as { runtimeId: string }).runtimeId
    }
    identity = { runtimeId, ownerInstanceId: mintObjectId(), pid: process.pid, stateDirectory }
    await new Promise<void>((accept, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        accept()
      })
    })
    socketIdentity = await lstat(socketPath)
    await chmod(socketPath, 0o600)
  } catch (error) {
    for (const connection of connections) connection.disconnect()
    server.close()
    await owner.close()
    throw error
  }
  let closing: Promise<void> | undefined
  return {
    async identity() {
      return structuredClone(identity)
    },
    close() {
      closing ??= (async () => {
        for (const connection of connections) connection.disconnect()
        await new Promise<void>((accept, reject) =>
          server.close((error) => (error ? reject(error) : accept())),
        )
        await owner.close()
        const current = await lstat(socketPath).catch((error) => {
          if (errorCode(error) === 'ENOENT') return null
          throw error
        })
        if (
          current &&
          current.dev === socketIdentity?.dev &&
          current.ino === socketIdentity.ino &&
          current.isSocket()
        )
          await unlink(socketPath)
      })()
      return closing
    },
  }
}
