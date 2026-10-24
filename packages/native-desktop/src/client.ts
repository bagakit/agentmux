import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pngBytes, pngFromBytes, type NativePng } from './image.js'
import { decodeResponse, isNativeMutation, NATIVE_PROTOCOL_VERSION, NATIVE_PROVIDER,
  type CaptureParams, type CaptureResult, type Json, type JsonObject,
  type NativeMethod, type NativeOperation, type NativeResponse } from './protocol.js'

const MAX_FRAME_BYTES = 26 * 1024 * 1024
const RESULT_CACHE_BYTES = 32 * 1024 * 1024

function freezeReceivedJson(value: Json): Json {
  const pending: Json[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) pending.push(child)
      Object.freeze(item)
    }
  }
  return value
}

export class NativeRequestError extends Error {
  constructor(readonly code: string, message: string, readonly operation?: NativeOperation) {
    super(operation ? `${message} Original native operation: ${operation.operationId}; instance: ${operation.instanceId}; request: ${operation.requestId}; receipt: ${operation.state}.` : message)
    this.name = 'NativeRequestError'
  }
}

interface Pending {
  resolve(value: Json): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  operation?: NativeOperation
  settled: boolean
}

export interface NativeConnectionOptions {
  socketPath: string
  token: string
  requestTimeoutMs?: number
}
export interface NativeRequestOptions {
  operationId?: string; expectedInstanceId?: string; timeoutMs?: number
  /** Original host authority, checked after lazy connection and immediately before submission. */
  beforeSubmit?(): void | Promise<void>
}

/** One authenticated native connection. Lost writes are never re-sent. */
export class NativeConnection {
  private sequence = 0
  private pending = new Map<number, Pending>()
  private operations = new Map<string, NativeOperation>()
  private submittedOperationIds = new Set<string>()
  private resultSizes = new Map<string, number>()
  private resultBytes = 0
  private chunks: Buffer[] = []
  private bufferedBytes = 0
  private closed = false
  private instance = ''
  private constructor(private socket: Socket, private options: NativeConnectionOptions) {
    socket.on('data', bytes => this.receive(bytes))
    socket.on('error', error => this.fail(error))
    socket.on('close', () => this.fail(new Error('Native connection closed')))
  }

  static async connect(options: NativeConnectionOptions): Promise<NativeConnection> {
    const info = await lstat(options.socketPath)
    if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new NativeRequestError('unsafe_socket', 'Native socket must be private and owned by the current user')
    }
    const socket = connect(options.socketPath)
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { socket.destroy(); reject(error) }
      socket.once('error', failed)
      socket.once('connect', () => { socket.off('error', failed); resolve() })
    })
    const connection = new NativeConnection(socket, options)
    try {
      const hello = await connection.request('handshake', {})
      if (!hello || typeof hello !== 'object' || Array.isArray(hello) || hello.provider !== NATIVE_PROVIDER ||
          hello.protocolVersion !== NATIVE_PROTOCOL_VERSION || hello.instanceId !== connection.instanceId) {
        throw new NativeRequestError('incompatible_protocol', 'Native handshake identity or version does not match')
      }
      return connection
    } catch (error) { connection.close(); throw error }
  }

  get instanceId(): string { return this.instance }
  get isClosed(): boolean { return this.closed }

  inspectOperation(operationId: string): NativeOperation | undefined {
    const operation = this.operations.get(operationId)
    return operation ? structuredClone(operation) : undefined
  }

  async request(method: NativeMethod, params: JsonObject, options: NativeRequestOptions = {}): Promise<Json> {
    await options.beforeSubmit?.()
    if (this.closed) throw new NativeRequestError('unavailable', 'The original native connection is closed')
    const mutation = isNativeMutation(method, params)
    const expectedInstanceId = options.expectedInstanceId ?? this.instance
    if (method !== 'handshake' && (!expectedInstanceId || expectedInstanceId !== this.instance)) {
      throw new NativeRequestError('instance_mismatch', 'The original native instance is unavailable; the operation was not re-sent')
    }
    const operationId = mutation ? options.operationId ?? randomUUID() : undefined
    if (operationId && this.submittedOperationIds.has(operationId)) {
      throw new NativeRequestError('duplicate_operation', 'Inspect the original operation; it will not be executed again', this.inspectOperation(operationId))
    }
    const id = ++this.sequence
    const operation: NativeOperation | undefined = operationId ? {
      operationId, requestId: id, instanceId: this.instance, method, state: 'pending'
    } : undefined
    const frame = JSON.stringify({ id, method, params, token: this.options.token,
      ...(operationId ? { operationId } : {}), ...(expectedInstanceId ? { expectedInstanceId } : {}) }) + '\n'
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new NativeRequestError('request_too_large', 'Native request exceeds the frame limit')
    if (operation) {
      this.submittedOperationIds.add(operation.operationId)
      this.operations.set(operation.operationId, operation)
    }
    return await new Promise<Json>((resolve, reject) => {
      const pending: Pending = { resolve, reject, settled: false,
        timer: setTimeout(() => {
          pending.settled = true
          if (operation) operation.state = 'unknown'
          else this.pending.delete(id)
          reject(new NativeRequestError(operation ? 'operation_unknown' : 'request_timeout',
            operation ? 'The result of this native operation is unknown. Inspect its original identity before taking another action.' : 'Native query timed out',
            operation ? structuredClone(operation) : undefined))
        }, options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000), ...(operation ? { operation } : {}) }
      this.pending.set(id, pending)
      this.socket.write(frame, error => { if (error) this.fail(error) })
    })
  }

  close(): void { this.socket.destroy(); this.fail(new Error('Native connection closed by its owner')) }

  private receive(bytes: Buffer): void {
    if (this.closed) return
    let cursor = 0
    while (cursor < bytes.byteLength) {
      const end = bytes.indexOf(10, cursor)
      const part = bytes.subarray(cursor, end < 0 ? bytes.byteLength : end)
      this.bufferedBytes += part.byteLength
      if (this.bufferedBytes > MAX_FRAME_BYTES) { this.protocolFailure(); return }
      this.chunks.push(part)
      if (end < 0) return
      const line = (this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.bufferedBytes)).toString('utf8')
      this.chunks = []
      this.bufferedBytes = 0
      cursor = end + 1
      let response: NativeResponse
      try { response = decodeResponse(JSON.parse(line)) } catch { this.protocolFailure(); return }
      const pending = this.pending.get(response.id)
      // A timed-out read can arrive late; it grants no new authority.
      if (!pending) continue
      if ((!this.instance && response.id !== 1) || (this.instance && response.instanceId !== this.instance) ||
          response.operationId !== pending.operation?.operationId) { this.protocolFailure(); return }
      this.instance ||= response.instanceId
      this.pending.delete(response.id)
      clearTimeout(pending.timer)
      if (pending.operation) {
        pending.operation.state = response.ok ? 'completed' : 'failed'
        if (response.error) pending.operation.error = response.error
        if (response.ok) {
          // Late responses remain inspectable on their original operation. Keep the
          // received object, without another PNG encode or a second result owner.
          pending.operation.result = freezeReceivedJson(response.result!)
          pending.operation.resultAvailability = 'retained'
          this.resultSizes.set(pending.operation.operationId, Buffer.byteLength(line))
          this.resultBytes += Buffer.byteLength(line)
          for (const [key, size] of this.resultSizes) {
            if (this.resultBytes <= RESULT_CACHE_BYTES) break
            const old = this.operations.get(key)
            if (old) { delete old.result; old.resultAvailability = 'expired' }
            this.resultSizes.delete(key)
            this.resultBytes -= size
          }
        }
        // Bound compact receipt retention; submitted IDs remain ineligible for replay.
        if (this.operations.size > 1024) {
          for (const [key, value] of this.operations) {
            if (value.state === 'completed' || value.state === 'failed') {
              this.operations.delete(key)
              this.resultBytes -= this.resultSizes.get(key) ?? 0
              this.resultSizes.delete(key)
            }
            if (this.operations.size <= 1024) break
          }
        }
      }
      if (!pending.settled) {
        pending.settled = true
        if (response.ok) pending.resolve(response.result!)
        else pending.reject(new NativeRequestError(response.error!.code, response.error!.message,
          pending.operation ? structuredClone(pending.operation) : undefined))
      }
    }
  }

  private protocolFailure(): void {
    this.fail(new NativeRequestError('invalid_protocol', 'Native response identity or frame is invalid'))
    this.socket.destroy()
  }
  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.chunks = []
    this.bufferedBytes = 0
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      if (pending.operation) pending.operation.state = 'unknown'
      if (!pending.settled) pending.reject(pending.operation
        ? new NativeRequestError('operation_unknown', error.message, structuredClone(pending.operation)) : error)
    }
    this.pending.clear()
  }
}

export interface NativeDesktopOptions {
  appPath?: string
  executablePath?: string
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

/** A host-owned, lazy native capability, independent of Agent Sessions and Runs. */
export class NativeDesktop {
  private connecting: Promise<NativeConnection> | undefined
  private connection: NativeConnection | undefined
  private connections: NativeConnection[] = []
  private directories = new Set<string>()
  private submittedOperationIds = new Set<string>()
  private disposed = false
  constructor(private options: NativeDesktopOptions) {}

  async request(method: NativeMethod, params: JsonObject = {}, options: NativeRequestOptions = {}): Promise<Json> {
    if (this.disposed) throw new NativeRequestError('unavailable', 'The native desktop owner is disposed')
    const connection = await this.ensureConnection()
    if (this.disposed) throw new NativeRequestError('unavailable', 'The native desktop owner is disposed')
    const beforeSubmit = async () => {
      await options.beforeSubmit?.()
      if (this.disposed) throw new NativeRequestError('unavailable', 'The native desktop owner is disposed')
    }
    if (isNativeMutation(method, params)) {
      const operationId = options.operationId ?? randomUUID()
      if (this.submittedOperationIds.has(operationId)) throw new NativeRequestError('duplicate_operation', 'Inspect the original operation; it will not be executed again')
      if (options.expectedInstanceId !== undefined && options.expectedInstanceId !== connection.instanceId) throw new NativeRequestError('instance_mismatch', 'The original native instance is unavailable')
      this.submittedOperationIds.add(operationId)
      return await connection.request(method, params, { ...options, operationId, beforeSubmit })
    }
    return await connection.request(method, params, { ...options, beforeSubmit })
  }

  inspectOperation(operationId: string, instanceId: string): NativeOperation | { operationId: string; instanceId: string; state: 'unknown'; reason: string } {
    // Inspection never starts a new process or makes an old request eligible again.
    for (const connection of this.connections) {
      if (connection.instanceId === instanceId) {
        const operation = connection.inspectOperation(operationId)
        if (operation) return operation
      }
    }
    return { operationId, instanceId, state: 'unknown', reason: 'original_receipt_unavailable' }
  }

  async captureScreenshot(params: CaptureParams = { mode: 'selection' }): Promise<CaptureResult> {
    const operationId = randomUUID()
    const raw = await this.request('captureScreenshot', params as unknown as JsonObject, { operationId, timeoutMs: 120_000 })
    const invalid = (message: string) => new NativeRequestError('invalid_capture_result', message,
      this.connections.map(connection => connection.inspectOperation(operationId)).find(Boolean))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.state !== 'string' || !['captured', 'cancelled', 'failed'].includes(raw.state)) {
      throw invalid('Native capture did not return a typed outcome')
    }
    const result = raw as unknown as CaptureResult
    if (result.state === 'captured') {
      const screenshot = result.screenshot
      if (!screenshot || screenshot.format !== 'png' || typeof screenshot.data !== 'string' || !Number.isFinite(screenshot.scale) || screenshot.scale <= 0) {
        throw invalid('Native capture did not return a PNG')
      }
      try {
        pngBytes({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + screenshot.data,
          width: screenshot.width, height: screenshot.height, byteLength: Buffer.from(screenshot.data, 'base64').byteLength })
      } catch (error) { throw invalid(error instanceof Error ? error.message : 'Native capture PNG is invalid') }
      if (result.error !== undefined) throw invalid('Captured result also reported a failure')
    } else {
      if (result.screenshot !== undefined || result.state === 'cancelled' && result.error !== undefined) throw invalid('Uncaptured result contains pixels or a contradictory failure')
      if (result.state === 'failed' && (!result.error || typeof result.error.code !== 'string' || !result.error.code || typeof result.error.message !== 'string')) {
        throw invalid('Failed capture is missing its failure receipt')
      }
    }
    return result
  }

  async readClipboardText(): Promise<string> {
    const result = await this.request('clipboardRead', { format: 'text' })
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.format !== 'text' ||
        !Number.isSafeInteger(result.changeCount) || (result.changeCount as number) < 0) throw new NativeRequestError('invalid_clipboard_result', 'Native clipboard did not return a text receipt')
    if (result.data === null && result.state === 'empty') return ''
    if (result.state !== 'read' || typeof result.data !== 'string') throw new NativeRequestError('invalid_clipboard_result', 'Native clipboard did not return text')
    return result.data
  }
  async writeClipboardText(text: string): Promise<void> { await this.writeClipboard('text', text) }
  async readClipboardImage(): Promise<NativePng | null> {
    const result = await this.request('clipboardRead', { format: 'png' })
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.format !== 'png' ||
        !Number.isSafeInteger(result.changeCount) || (result.changeCount as number) < 0) throw new NativeRequestError('invalid_clipboard_result', 'Invalid native clipboard image receipt')
    if (result.data === null && result.state === 'empty') return null
    if (result.state !== 'read' || typeof result.data !== 'string') throw new NativeRequestError('invalid_clipboard_result', 'Native clipboard did not return PNG data')
    const image = pngFromBytes(Buffer.from(result.data, 'base64'))
    pngBytes({ ...image, dataUrl: 'data:image/png;base64,' + result.data })
    return image
  }
  async writeClipboardImage(image: NativePng): Promise<void> { await this.writeClipboard('png', pngBytes(image).toString('base64')) }

  private async writeClipboard(format: 'text' | 'png', data: string): Promise<void> {
    const operationId = randomUUID()
    const result = await this.request('clipboardWrite', { format, data }, { operationId })
    const expectedBytes = format === 'text' ? Buffer.byteLength(data) : Buffer.from(data, 'base64').byteLength
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.format !== format || result.state !== 'written' ||
        result.byteLength !== expectedBytes || !Number.isSafeInteger(result.changeCount) || (result.changeCount as number) < 0) {
      const operation = this.connections.map(connection => connection.inspectOperation(operationId)).find(Boolean)
      throw new NativeRequestError('invalid_clipboard_result', 'The native clipboard write receipt is unconfirmed', operation)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.connection?.close()
    await this.connecting?.catch(() => {})
    for (const connection of this.connections) connection.close()
    this.connection = undefined
    // Native owns its listener; closing the authenticated connection ends this launch.
    // Only remove token files here. The listener removes its exact socket/directory.
    for (const directory of this.directories) await rm(join(directory, 'token'), { force: true })
  }

  private async ensureConnection(): Promise<NativeConnection> {
    if (this.disposed) throw new NativeRequestError('unavailable', 'The native desktop owner is disposed')
    if (this.connection && !this.connection.isClosed) return this.connection
    this.connecting ??= this.launch().then(connection => {
      if (this.disposed) {
        connection.close()
        throw new NativeRequestError('unavailable', 'The native desktop owner was disposed during launch')
      }
      this.connection = connection
      this.connections.push(connection)
      return connection
    }).finally(() => { this.connecting = undefined })
    return await this.connecting
  }

  private async launch(): Promise<NativeConnection> {
    if (process.platform !== 'darwin') throw new NativeRequestError('unavailable', 'The native desktop implementation is only available on macOS')
    if (!this.options.appPath && !this.options.executablePath) throw new NativeRequestError('unavailable', 'No native desktop application was supplied by this host')
    const directory = await mkdtemp(join(tmpdir(), 'amux-native-'))
    await chmod(directory, 0o700)
    this.directories.add(directory)
    const socketPath = join(directory, 'native.sock')
    const tokenPath = join(directory, 'token')
    const token = randomBytes(32).toString('hex')
    await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' })
    const args = ['--agent', socketPath, '--token-file', tokenPath, '--parent-pid', String(process.pid)]
    const command = this.options.appPath ? '/usr/bin/open' : this.options.executablePath!
    const launchArgs = this.options.appPath ? ['-n', '-g', this.options.appPath, '--args', ...args] : args
    const child = spawn(command, launchArgs, { stdio: 'ignore', env: process.env })
    let launchError: Error | undefined
    child.on('error', error => { launchError = error })
    child.once('exit', code => { if (code !== 0) launchError = new Error(`Native launcher exited with code ${code}`) })
    child.unref()
    const deadline = Date.now() + (this.options.connectTimeoutMs ?? 10_000)
    try {
      while (Date.now() < deadline) {
        if (this.disposed) throw new NativeRequestError('unavailable', 'The native desktop owner was disposed during launch')
        if (launchError) throw launchError
        try {
          return await NativeConnection.connect({ socketPath, token,
            ...(this.options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.options.requestTimeoutMs }) })
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error
        }
        await delay(40)
      }
      throw new NativeRequestError('unavailable', 'The native application did not open its authenticated socket')
    } finally {
      // The native launch reads this once before listening; do not leave credentials behind.
      await rm(tokenPath, { force: true })
    }
  }
}
