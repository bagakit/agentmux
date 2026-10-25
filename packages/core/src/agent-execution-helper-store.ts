import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { parseAgentExecutionNotices, type AgentExecutionHelperInput, type AgentExecutionHelperPreparation } from './agent-execution-helper.js'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parsePreparedTerminal } from './terminal-preparation.js'
import { parseAgentToolExecutionBinding } from './agent-tool-execution.js'

export type AgentExecutionFrontendPin = { runId: string; ownerInstanceId: string; url: string }
export type AgentExecutionHelperRecord = { input: AgentExecutionHelperInput; preparation: AgentExecutionHelperPreparation; frontend?: AgentExecutionFrontendPin }
type RecordValue = AgentExecutionHelperRecord & { schemaVersion: 1 }
type Flight = { input: AgentExecutionHelperInput; result: Promise<AgentExecutionHelperPreparation> }
const flights = new Map<string, Flight>()
const pins = new Map<string, Promise<AgentExecutionFrontendPin>>()
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
const text = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\0\r\n]/u.test(value)
const fail = (message: string, code = 'AGENT_EXECUTION_HELPER_CONFLICT') => new AgentMuxError(message, code)

function inputValue(value: unknown): AgentExecutionHelperInput {
  const r = rpcRecord(value, ['bindingId', 'role', 'providerId', 'workspacePath', 'createOperationId', 'grant', 'toolExecution', 'agentSessionId'])
  if (!text(r.bindingId) || !['frontend', 'executor'].includes(r.role as string) || !text(r.providerId) || !text(r.workspacePath) || !isAbsolute(r.workspacePath) || !text(r.createOperationId)) throw fail('Invalid execution helper identity', 'INVALID_EXECUTION_HELPER')
  if (r.grant !== undefined) {
    const grant = rpcRecord(r.grant, ['scope', 'bindingId'])
    if (grant.scope !== 'host-user' || grant.bindingId !== r.bindingId) throw fail('The resource grant does not belong to this helper binding', 'INVALID_EXECUTION_HELPER')
  }
  const toolExecution = r.toolExecution === undefined ? undefined : parseAgentToolExecutionBinding(r.toolExecution)
  if (toolExecution !== undefined && toolExecution.bindingId !== r.bindingId) throw fail('The tool resource does not belong to this helper binding', 'INVALID_EXECUTION_HELPER')
  if (r.agentSessionId !== undefined && !text(r.agentSessionId)) throw fail('Invalid original Agent Session identity', 'INVALID_EXECUTION_HELPER')
  return { bindingId: r.bindingId, role: r.role as AgentExecutionHelperInput['role'], providerId: r.providerId, workspacePath: r.workspacePath, createOperationId: r.createOperationId,
    ...(r.agentSessionId === undefined ? {} : { agentSessionId: r.agentSessionId as string }),
    ...(toolExecution === undefined ? {} : { toolExecution }),
    ...(r.grant === undefined ? {} : { grant: { scope: 'host-user' as const, bindingId: r.bindingId } }) }
}

function recordValue(value: unknown): RecordValue {
  try {
    const r = rpcRecord(value, ['schemaVersion', 'input', 'preparation', 'frontend'])
    const input = inputValue(r.input)
    const preparation = rpcRecord(r.preparation, ['bindingId', 'role', 'providerId', 'prepared', 'journalIdentity', 'notices'])
    const prepared = parsePreparedTerminal(preparation.prepared)
    if (r.schemaVersion !== 1 || preparation.bindingId !== input.bindingId || preparation.role !== input.role || preparation.providerId !== input.providerId || prepared.createOperationId !== input.createOperationId || prepared.workspacePath !== input.workspacePath) throw new Error('identity mismatch')
    if (input.role === 'executor' ? !text(preparation.journalIdentity) : preparation.journalIdentity !== undefined) throw new Error('journal identity mismatch')
    if (r.frontend !== undefined && input.role !== 'frontend') throw new Error('wrong endpoint role')
    return { schemaVersion: 1, input, preparation: { bindingId: input.bindingId, role: input.role, providerId: input.providerId, prepared,
      ...(preparation.notices === undefined ? {} : { notices: parseAgentExecutionNotices(preparation.notices, { providerId: input.providerId, role: input.role }) }),
      ...(input.role === 'executor' ? { journalIdentity: preparation.journalIdentity as string } : {}) },
      ...(r.frontend === undefined ? {} : { frontend: frontendValue(r.frontend) }) }
  } catch { throw fail('The original private execution helper preparation is invalid; it was not replaced', 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED') }
}

function frontendValue(value: unknown): AgentExecutionFrontendPin {
  const r = rpcRecord(value, ['runId', 'ownerInstanceId', 'url'])
  if (!text(r.runId) || !text(r.ownerInstanceId) || !text(r.url)) throw fail('Invalid original frontend endpoint identity', 'INVALID_EXECUTION_HELPER')
  let url: URL
  try { url = new URL(r.url) } catch { throw fail('Invalid original frontend endpoint', 'INVALID_EXECUTION_HELPER') }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname === '/' || url.username || url.password || url.search || url.hash) throw fail('The frontend endpoint must be the exact loopback capability URL', 'INVALID_EXECUTION_HELPER')
  return { runId: r.runId, ownerInstanceId: r.ownerInstanceId, url: r.url }
}

/** Private launch material only. No environment or capability URL enters a public summary. */
export class AgentExecutionHelperStore {
  private readonly directory: string
  constructor(root: string) {
    if (!isAbsolute(root)) throw fail('The exact Core state root must be absolute', 'INVALID_EXECUTION_HELPER')
    this.directory = join(resolve(root), 'execution-helpers')
  }
  private path(bindingId: string, role: AgentExecutionHelperInput['role']): string {
    if (!text(bindingId) || !['frontend', 'executor'].includes(role)) throw fail('Invalid execution helper identity', 'INVALID_EXECUTION_HELPER')
    return join(this.directory, createHash('sha256').update(JSON.stringify([bindingId, role])).digest('hex') + '.json')
  }
  private async readPath(path: string): Promise<RecordValue | null> {
    let raw: string
    try { raw = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw fail('The original private execution helper preparation cannot be read', 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED')
    }
    try { return recordValue(JSON.parse(raw)) }
    catch { throw fail('The original private execution helper preparation is invalid; it was not replaced', 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED') }
  }
  async read(bindingId: string, role: AgentExecutionHelperInput['role']): Promise<AgentExecutionHelperRecord | null> {
    const record = await this.readPath(this.path(bindingId, role))
    if (!record) return null
    if (record.input.bindingId !== bindingId || record.input.role !== role) throw fail('The retained preparation belongs to another original helper', 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED')
    return { input: record.input, preparation: record.preparation, ...(record.frontend === undefined ? {} : { frontend: record.frontend }) }
  }
  /** The Core callback proves the original Run and endpoint; this stores its receipt only. */
  async pinFrontend(bindingId: string, build: (record: AgentExecutionHelperRecord) => Promise<AgentExecutionFrontendPin>): Promise<AgentExecutionFrontendPin> {
    const path = this.path(bindingId, 'frontend')
    const pending = pins.get(path)
    if (pending) return structuredClone(await pending)
    const result = this.locked(path, async () => {
      const record = await this.readPath(path)
      if (!record || record.input.bindingId !== bindingId || record.input.role !== 'frontend') throw fail('The original frontend preparation is unavailable; no replacement was created', 'AGENT_EXECUTION_HELPER_STORAGE_UNCONFIRMED')
      if (record.frontend) {
        await durableWriteFile(path, JSON.stringify(record) + '\n', { mode: 0o600, requireDirectorySync: true })
        return record.frontend
      }
      const frontend = frontendValue(await build({ input: structuredClone(record.input), preparation: structuredClone(record.preparation) }))
      await durableWriteFile(path, JSON.stringify({ ...record, frontend }) + '\n', { mode: 0o600, requireDirectorySync: true })
      return frontend
    })
    pins.set(path, result)
    try { return structuredClone(await result) } finally { if (pins.get(path) === result) pins.delete(path) }
  }
  async prepare(value: AgentExecutionHelperInput, build: () => Promise<AgentExecutionHelperPreparation>): Promise<AgentExecutionHelperPreparation> {
    const input = inputValue(value), path = this.path(input.bindingId, input.role)
    const prior = flights.get(path)
    if (prior) {
      if (!isDeepStrictEqual(prior.input, input)) throw fail('This helper binding already has a different original preparation intent')
      return structuredClone(await prior.result)
    }
    const result = this.locked(path, async () => {
      const retained = await this.readPath(path)
      if (retained) {
        if (!isDeepStrictEqual(retained.input, input)) throw fail('This helper binding already has a different original preparation intent')
        // Re-acknowledge exact retained bytes after a possibly lost fsync receipt.
        await durableWriteFile(path, JSON.stringify(retained) + '\n', { mode: 0o600, requireDirectorySync: true })
        return retained.preparation
      }
      const preparation = await build()
      const record = recordValue({ schemaVersion: 1, input, preparation })
      await durableWriteFile(path, JSON.stringify(record) + '\n', { mode: 0o600, requireDirectorySync: true })
      return record.preparation
    })
    const flight = { input, result }; flights.set(path, flight)
    try { return structuredClone(await result) } finally { if (flights.get(path) === flight) flights.delete(path) }
  }
  private async locked<T>(path: string, work: () => Promise<T>): Promise<T> {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    // Stable lock inode; removing it would split concurrent owners' authority.
    const lock = await open(path + '.lock', 'a+', 0o600)
    try {
      await lock.chmod(0o600)
      while (!native.tryLock(lock.fd)) await delay(10)
      // A successful mkdir is not a durability receipt. Acknowledge namespace
      // ancestors before retaining launch material, including competing creators.
      const stop = created ? dirname(created) : dirname(this.directory)
      for (let directory = this.directory;; directory = dirname(directory)) {
        const handle = await open(directory, 'r')
        try { await handle.sync() } finally { await handle.close() }
        if (directory === stop) break
      }
      return await work()
    } finally { await lock.close() }
  }
}
