import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  AGENTMUX_COMPOSITION_SCHEMA_VERSION,
  type AgentMuxAgentRegion,
  type AgentMuxCompositionControl,
  type AgentMuxCompositionExecutor,
  type AgentMuxCompositionErrorReceipt,
  type AgentMuxCompositionReceipt,
  type AgentMuxCompositionRequest,
  type AgentMuxCompositionResult,
  type AgentMuxCompositionSuccessReceipt,
  type AgentMuxCompositionViewRegion,
  type AgentMuxRegion,
  type AgentMuxRegionBounds,
  type AgentMuxRegionPlacement,
  type AgentMuxRelativeRegion
} from './composition.js'
import { AgentMuxError } from './errors.js'
import { defaultAgentMuxCompositionSocketPath } from './runtime-paths.js'

const MAX_MESSAGE_BYTES = 256 * 1024
const MAX_ID_BYTES = 512
const MAX_VIEW_REGIONS = 64
const MAX_EXECUTORS = 128
const REQUEST_TIMEOUT_MS = 2_000
const LAUNCH_REQUEST_TIMEOUT_MS = 60_000
const OPERATIONS = ['context', 'region.open', 'region.focus', 'launch'] as const
const PLACEMENTS: readonly AgentMuxRegionPlacement[] = [
  'tab', 'split-left', 'split-right', 'split-up', 'split-down'
]

function record(value: unknown, message: string, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError(message, code)
  }
  return value as Record<string, unknown>
}

function id(value: unknown, message: string, code: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > MAX_ID_BYTES ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new AgentMuxError(message, code)
  }
  return value
}

function normalizedNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new AgentMuxError(
      'Composition Region bounds are invalid.',
      'COMPOSITION_PROTOCOL_ERROR'
    )
  }
  return value
}

function regionBounds(value: unknown): AgentMuxRegionBounds {
  const source = record(
    value,
    'Composition Region bounds are invalid.',
    'COMPOSITION_PROTOCOL_ERROR'
  )
  const bounds = {
    x: normalizedNumber(source.x),
    y: normalizedNumber(source.y),
    width: normalizedNumber(source.width),
    height: normalizedNumber(source.height)
  }
  if (
    bounds.width === 0 ||
    bounds.height === 0 ||
    bounds.x + bounds.width > 1 + Number.EPSILON ||
    bounds.y + bounds.height > 1 + Number.EPSILON
  ) {
    throw new AgentMuxError(
      'Composition Region bounds are invalid.',
      'COMPOSITION_PROTOCOL_ERROR'
    )
  }
  return bounds
}

function compositionViewRegion(value: unknown): AgentMuxCompositionViewRegion {
  const source = record(
    value,
    'Composition View Region is invalid.',
    'COMPOSITION_PROTOCOL_ERROR'
  )
  const base = {
    regionId: id(
      source.regionId,
      'Composition View Region is invalid.',
      'COMPOSITION_PROTOCOL_ERROR'
    ),
    bounds: regionBounds(source.bounds)
  }
  if (source.kind === 'agent') {
    return {
      ...base,
      kind: source.kind,
      providerId: id(
        source.providerId,
        'Composition View Region is invalid.',
        'COMPOSITION_PROTOCOL_ERROR'
      ),
      executorId: id(
        source.executorId,
        'Composition View Region is invalid.',
        'COMPOSITION_PROTOCOL_ERROR'
      ),
      agentSessionId: id(
        source.agentSessionId,
        'Composition View Region is invalid.',
        'COMPOSITION_PROTOCOL_ERROR'
      )
    }
  }
  if (source.kind === 'terminal') {
    return {
      ...base,
      kind: source.kind,
      runId: id(
        source.runId,
        'Composition View Region is invalid.',
        'COMPOSITION_PROTOCOL_ERROR'
      )
    }
  }
  if (source.kind === 'other') return { ...base, kind: source.kind }
  throw new AgentMuxError(
    'Composition View Region is invalid.',
    'COMPOSITION_PROTOCOL_ERROR'
  )
}

function compositionViewRegions(
  value: unknown,
  caller: { regionId: string; agentSessionId: string }
): AgentMuxCompositionViewRegion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_VIEW_REGIONS) {
    throw new AgentMuxError(
      'Composition View Regions are invalid.',
      'COMPOSITION_PROTOCOL_ERROR'
    )
  }
  const regions = value.map(compositionViewRegion)
  const regionIds = new Set(regions.map((region) => region.regionId))
  const callerRegion = regions.find((region) => region.regionId === caller.regionId)
  if (
    regionIds.size !== regions.length ||
    callerRegion?.kind !== 'agent' ||
    callerRegion.agentSessionId !== caller.agentSessionId
  ) {
    throw new AgentMuxError(
      'Composition View Regions are invalid.',
      'COMPOSITION_PROTOCOL_ERROR'
    )
  }
  return regions
}

function compositionExecutors(value: unknown): AgentMuxCompositionExecutor[] {
  if (!Array.isArray(value) || value.length > MAX_EXECUTORS) {
    throw new AgentMuxError('Composition Executors are invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  const executors = value.map((value) => {
    const source = record(value, 'Composition Executor is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
    if (typeof source.label !== 'string' || !source.label.trim() || Buffer.byteLength(source.label) > MAX_ID_BYTES) {
      throw new AgentMuxError('Composition Executor is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
    }
    if (typeof source.available !== 'boolean') {
      throw new AgentMuxError('Composition Executor is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
    }
    return {
      executorId: id(source.executorId, 'Composition Executor is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
      label: source.label,
      providerId: id(source.providerId, 'Composition Executor is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
      available: source.available
    }
  })
  if (new Set(executors.map((executor) => executor.executorId)).size !== executors.length) {
    throw new AgentMuxError('Composition Executor identity is ambiguous.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  return executors
}

function caller(value: unknown): { agentSessionId: string } {
  const source = record(value, 'Composition caller is invalid.', 'INVALID_COMPOSITION_REQUEST')
  return {
    agentSessionId: id(
      source.agentSessionId,
      'Composition caller is invalid.',
      'INVALID_COMPOSITION_REQUEST'
    )
  }
}

function placement(value: unknown): AgentMuxRegionPlacement {
  if (!PLACEMENTS.includes(value as AgentMuxRegionPlacement)) {
    throw new AgentMuxError('Composition placement is invalid.', 'INVALID_COMPOSITION_REQUEST')
  }
  return value as AgentMuxRegionPlacement
}

function relativeRegion(value: unknown): AgentMuxRelativeRegion {
  const source = record(value, 'Relative Region is invalid.', 'INVALID_COMPOSITION_REQUEST')
  if (source.kind === 'self') return { kind: 'self' }
  if (source.kind === 'region') {
    return {
      kind: 'region',
      regionId: id(source.regionId, 'Relative Region is invalid.', 'INVALID_COMPOSITION_REQUEST')
    }
  }
  throw new AgentMuxError('Relative Region is invalid.', 'INVALID_COMPOSITION_REQUEST')
}

export function parseAgentMuxCompositionRequest(value: unknown): AgentMuxCompositionRequest {
  const source = record(value, 'Composition request is invalid.', 'INVALID_COMPOSITION_REQUEST')
  if (source.schemaVersion !== AGENTMUX_COMPOSITION_SCHEMA_VERSION) {
    throw new AgentMuxError('Composition request version is invalid.', 'INVALID_COMPOSITION_REQUEST')
  }
  const requestId = id(source.requestId, 'Composition request ID is invalid.', 'INVALID_COMPOSITION_REQUEST')
  const operation = source.operation
  if (!(OPERATIONS as readonly unknown[]).includes(operation)) {
    throw new AgentMuxError('Composition operation is invalid.', 'INVALID_COMPOSITION_REQUEST')
  }
  if (operation === 'context') {
    return {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId,
      operation,
      caller: caller(source.caller)
    }
  }
  if (operation === 'region.open') {
    return {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId,
      operation,
      caller: caller(source.caller),
      agentSessionId: id(
        source.agentSessionId,
        'Agent Session target is invalid.',
        'INVALID_COMPOSITION_REQUEST'
      ),
      placement: placement(source.placement),
      relativeTo: relativeRegion(source.relativeTo)
    }
  }
  if (operation === 'region.focus') {
    return {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId,
      operation,
      regionId: id(source.regionId, 'Region target is invalid.', 'INVALID_COMPOSITION_REQUEST')
    }
  }
  return {
    schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
    requestId,
    operation: 'launch',
    caller: caller(source.caller),
    executorId: id(source.executorId, 'Agent Executor is invalid.', 'INVALID_COMPOSITION_REQUEST'),
    ...(source.prompt === undefined
      ? {}
      : typeof source.prompt === 'string' && Buffer.byteLength(source.prompt) <= MAX_MESSAGE_BYTES
        ? { prompt: source.prompt }
        : (() => {
            throw new AgentMuxError('Agent prompt is invalid.', 'INVALID_COMPOSITION_REQUEST')
          })()),
    placement: placement(source.placement),
    relativeTo: relativeRegion(source.relativeTo)
  }
}

function region(value: unknown): AgentMuxRegion {
  const source = record(value, 'Composition Region result is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  const base = {
    viewId: id(source.viewId, 'Composition Region result is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
    regionId: id(source.regionId, 'Composition Region result is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
    workspaceId: id(source.workspaceId, 'Composition Region result is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
    tabGroupId: id(source.tabGroupId, 'Composition Region result is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  if (source.kind === 'agent') {
    return {
      ...base,
      kind: source.kind,
      agentSessionId: id(
        source.agentSessionId,
        'Composition Region result is invalid.',
        'COMPOSITION_PROTOCOL_ERROR'
      )
    }
  }
  if (source.kind === 'terminal') {
    return {
      ...base,
      kind: source.kind,
      runId: id(source.runId, 'Composition Region result is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
    }
  }
  throw new AgentMuxError('Composition Region result is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
}

function agentRegion(value: unknown): AgentMuxAgentRegion {
  const resolved = region(value)
  if (resolved.kind !== 'agent') {
    throw new AgentMuxError('Composition Agent Region result is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  return resolved
}

function successReceipt(
  request: AgentMuxCompositionRequest,
  result: AgentMuxCompositionResult
): AgentMuxCompositionSuccessReceipt {
  if (request.operation !== result.operation) {
    throw new AgentMuxError('Composition result operation does not match its request.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  switch (result.operation) {
    case 'context':
      return {
        schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
        requestId: request.requestId,
        ok: true,
        operation: result.operation,
        result: { context: result.context }
      }
    case 'region.open':
      return {
        schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
        requestId: request.requestId,
        ok: true,
        operation: result.operation,
        result: { region: result.region }
      }
    case 'region.focus':
      return {
        schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
        requestId: request.requestId,
        ok: true,
        operation: result.operation,
        result: { region: result.region }
      }
    case 'launch':
      return {
        schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
        requestId: request.requestId,
        ok: true,
        operation: result.operation,
        result: { agentSessionId: result.agentSessionId, region: result.region }
      }
  }
}

function parseSuccessReceipt(source: Record<string, unknown>): AgentMuxCompositionSuccessReceipt {
  const requestId = id(source.requestId, 'Composition receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  const operation = source.operation
  const result = record(source.result, 'Composition receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  if (operation === 'context') {
    const context = record(result.context, 'Composition context result is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
    const agentSessionId = id(
      context.agentSessionId,
      'Composition context result is invalid.',
      'COMPOSITION_PROTOCOL_ERROR'
    )
    const regionId = id(
      context.regionId,
      'Composition context result is invalid.',
      'COMPOSITION_PROTOCOL_ERROR'
    )
    return {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId,
      ok: true,
      operation,
      result: {
        context: {
          agentSessionId,
          workspaceId: id(context.workspaceId, 'Composition context result is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
          viewId: id(context.viewId, 'Composition context result is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
          regionId,
          tabGroupId: id(context.tabGroupId, 'Composition context result is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
          regions: compositionViewRegions(context.regions, { regionId, agentSessionId }),
          executors: compositionExecutors(context.executors)
        }
      }
    }
  }
  if (operation === 'region.open') {
    return {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId,
      ok: true,
      operation,
      result: { region: agentRegion(result.region) }
    }
  }
  if (operation === 'region.focus') {
    return {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId,
      ok: true,
      operation,
      result: { region: region(result.region) }
    }
  }
  if (operation === 'launch') {
    return {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId,
      ok: true,
      operation,
      result: {
        agentSessionId: id(result.agentSessionId, 'Composition launch result is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
        region: agentRegion(result.region)
      }
    }
  }
  throw new AgentMuxError('Composition receipt operation is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
}

export function parseAgentMuxCompositionReceipt(value: unknown): AgentMuxCompositionReceipt {
  const source = record(value, 'Composition receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  if (source.schemaVersion !== AGENTMUX_COMPOSITION_SCHEMA_VERSION) {
    throw new AgentMuxError('Composition receipt version is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  if (source.ok === true) return parseSuccessReceipt(source)
  if (source.ok === false) {
    const error = record(source.error, 'Composition error receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
    const requestId = source.requestId === null
      ? null
      : id(source.requestId, 'Composition error receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
    const operation = source.operation === null
      ? null
      : (OPERATIONS as readonly unknown[]).includes(source.operation)
        ? source.operation as AgentMuxCompositionRequest['operation']
        : (() => {
            throw new AgentMuxError('Composition error receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
          })()
    return {
      schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
      requestId,
      ok: false,
      operation,
      error: {
        code: id(error.code, 'Composition error receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR'),
        message: typeof error.message === 'string'
          ? error.message
          : (() => {
              throw new AgentMuxError('Composition error receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
            })()
      }
    }
  }
  throw new AgentMuxError('Composition receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
}

async function readMessage(socket: Socket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    let settled = false
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const parse = (content: Buffer): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        resolve(JSON.parse(content.toString('utf8')) as unknown)
      } catch {
        reject(new AgentMuxError('Composition message is invalid JSON.', 'COMPOSITION_PROTOCOL_ERROR'))
      }
    }
    const onData = (value: Buffer): void => {
      if (settled) return
      chunks.push(value)
      byteLength += value.length
      if (byteLength > MAX_MESSAGE_BYTES) {
        settled = true
        cleanup()
        reject(new AgentMuxError('Composition message is too large.', 'COMPOSITION_PROTOCOL_ERROR'))
        return
      }
      if (value.indexOf(0x0a) < 0) return
      const content = Buffer.concat(chunks, byteLength)
      const newline = content.indexOf(0x0a)
      const trailing = content.subarray(newline + 1)
      if (trailing.toString('utf8').trim()) {
        settled = true
        cleanup()
        reject(new AgentMuxError('Composition message has trailing data.', 'COMPOSITION_PROTOCOL_ERROR'))
        return
      }
      parse(content.subarray(0, newline))
    }
    const parseBuffered = (): void => parse(Buffer.concat(chunks, byteLength))
    const onEnd = (): void => parseBuffered()
    const onClose = (): void => parseBuffered()
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'COMPOSITION_FAILED'
}

function requestIdentity(value: unknown): {
  requestId: string | null
  operation: AgentMuxCompositionRequest['operation'] | null
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { requestId: null, operation: null }
  }
  const source = value as Record<string, unknown>
  return {
    requestId: typeof source.requestId === 'string' ? source.requestId : null,
    operation: (OPERATIONS as readonly unknown[]).includes(source.operation)
      ? source.operation as AgentMuxCompositionRequest['operation']
      : null
  }
}

async function socketIsActive(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new AgentMuxError('Composition endpoint probe timed out.', 'COMPOSITION_UNAVAILABLE'))
    }, 250)
    socket.once('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      socket.destroy()
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
  })
}

export class AgentMuxCompositionServer {
  private server: Server | null = null

  constructor(
    private readonly control: AgentMuxCompositionControl,
    readonly path = defaultAgentMuxCompositionSocketPath()
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.path), 0o700)
    try {
      const metadata = await lstat(this.path)
      const uid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid
      if (!metadata.isSocket() || metadata.uid !== uid || await socketIsActive(this.path)) {
        throw new AgentMuxError('Another Composition owner occupies the endpoint.', 'COMPOSITION_OWNER_BUSY')
      }
      await rm(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const server = createServer({ allowHalfOpen: true }, (socket) => void this.handle(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.path, () => resolve())
      })
      await chmod(this.path, 0o600)
      this.server = server
    } catch (error) {
      server.close()
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.path, { force: true })
  }

  private async handle(socket: Socket): Promise<void> {
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy())
    let raw: unknown
    let receipt: AgentMuxCompositionReceipt
    try {
      raw = await readMessage(socket)
      const request = parseAgentMuxCompositionRequest(raw)
      socket.setTimeout(request.operation === 'launch' ? LAUNCH_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
      const result = await this.control.execute(request)
      receipt = successReceipt(request, result)
    } catch (error) {
      const identity = requestIdentity(raw)
      receipt = {
        schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
        requestId: identity.requestId,
        ok: false,
        operation: identity.operation,
        error: {
          code: errorCode(error),
          message: error instanceof Error ? error.message : String(error)
        }
      } satisfies AgentMuxCompositionErrorReceipt
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify(receipt)}\n`)
  }
}

export async function requestAgentMuxComposition(
  value: AgentMuxCompositionRequest,
  path = defaultAgentMuxCompositionSocketPath()
): Promise<AgentMuxCompositionSuccessReceipt> {
  const request = parseAgentMuxCompositionRequest(value)
  const response = await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(path)
    socket.setTimeout(request.operation === 'launch' ? LAUNCH_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS, () => {
      socket.destroy(new AgentMuxError('Composition request timed out.', 'COMPOSITION_TIMEOUT'))
    })
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error instanceof AgentMuxError) reject(error)
      else if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        reject(new AgentMuxError('Composition owner is unavailable.', 'COMPOSITION_UNAVAILABLE'))
      } else reject(error)
    })
    void readMessage(socket).then(resolve, reject)
  })
  const receipt = parseAgentMuxCompositionReceipt(response)
  if (!receipt.ok) throw new AgentMuxError(receipt.error.message, receipt.error.code)
  if (receipt.requestId !== request.requestId || receipt.operation !== request.operation) {
    throw new AgentMuxError('Composition receipt does not match its request.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  return receipt
}
