import { spawn } from 'node:child_process'
import { AgentMuxError } from '../errors.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS } from '../session-history.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryItem
} from '../types.js'

function protocolError(): AgentMuxError {
  return new AgentMuxError('Native history returned an invalid protocol response.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError()
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw protocolError()
  return value
}

function resource(
  resourceType: 'image' | 'audio' | 'file' | 'other',
  reference: unknown,
  label?: unknown
): AgentSessionHistoryContentPart {
  return { kind: 'resource', resourceType, reference: string(reference),
    ...(label === undefined ? {} : { label: string(label) }) }
}

function userContent(value: unknown): AgentSessionHistoryContentPart {
  const part = object(value)
  switch (part.type) {
    case 'text': return { kind: 'text', text: string(part.text) }
    case 'image': return resource('image', part.url ?? part.fileId)
    case 'localImage': return resource('image', part.path)
    case 'audio': return resource('audio', part.url)
    case 'localAudio': return resource('audio', part.path)
    case 'skill': case 'mention': return resource('file', part.path, part.name)
    default: return { kind: 'text', text: JSON.stringify(part, null, 2) }
  }
}

function itemEntry(value: unknown): AgentSessionHistoryItem {
  const entry = object(value)
  const item = object(entry.item)
  const type = string(item.type)
  let kind: AgentSessionHistoryItem['kind'] = 'activity'
  let contentParts: AgentSessionHistoryContentPart[]
  if (type === 'userMessage') {
    if (!Array.isArray(item.content)) throw protocolError()
    kind = 'user-message'
    contentParts = item.content.map(userContent)
  } else if (type === 'agentMessage') {
    kind = 'assistant-message'
    contentParts = [{ kind: 'text', text: string(item.text) }]
  } else {
    // Native activity kinds evolve independently. Preserve their complete readable payload.
    contentParts = [{ kind: 'text', text: JSON.stringify(item, null, 2) }]
    if (type === 'imageView') contentParts.push(resource('image', item.path))
    if (type === 'imageGeneration' && typeof item.savedPath === 'string') contentParts.push(resource('image', item.savedPath))
  }
  const timestamp = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocolError()
    return value as number
  }
  const startedAt = timestamp(entry.startedAtMs)
  const completedAt = timestamp(entry.completedAtMs)
  return { id: string(item.id), turnId: string(entry.turnId), kind, contentParts,
    ...(kind === 'activity' ? { title: type } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }) }
}

/** Owns one bounded native read helper; it never starts, resumes or controls an Agent thread. */
export async function readCodexSessionHistoryPage(
  context: AgentProviderSessionHistoryContext
): Promise<AgentProviderSessionHistoryPage> {
  context.signal.throwIfAborted()
  const env = { ...process.env }
  for (const [name, value] of Object.entries(context.env)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  const child = spawn(context.command, [
    ...context.args, '-s', 'read-only', '-a', 'never', 'app-server', '--stdio'
  ], {
    cwd: context.workspacePath, env, detached: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>()
  let nextId = 0
  let receivedBytes = 0
  let failure: unknown
  let carry = ''
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const closed = new Promise<void>((resolve) => child.once('close', (code, signal) => {
    exit = { code, signal }
    if (pending.size) fail(new AgentMuxError(
      'The native history helper closed before the page completed.', 'AGENT_SESSION_HISTORY_UNAVAILABLE'
    ))
    resolve()
  }))
  const fail = (error: unknown): void => {
    failure ??= error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  const abort = (): void => fail(context.signal.reason)
  context.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => fail(new AgentMuxError(
    'Native history page timed out.', 'AGENT_SESSION_HISTORY_TIMEOUT'
  )), SESSION_HISTORY_TIMEOUT_MS)
  child.once('error', () => fail(new AgentMuxError(
    'The configured native history helper could not start.', 'AGENT_SESSION_HISTORY_UNAVAILABLE'
  )))
  child.stdin.on('error', () => fail(new AgentMuxError(
    'Native history request could not be sent.', 'AGENT_SESSION_HISTORY_UNAVAILABLE'
  )))
  const acceptBytes = (chunk: Buffer): boolean => {
    receivedBytes += chunk.byteLength
    if (receivedBytes <= SESSION_HISTORY_MAX_PAGE_BYTES) return failure === undefined
    fail(new AgentMuxError('Native history response exceeds its byte budget.', 'AGENT_SESSION_HISTORY_TOO_LARGE'))
    return false
  }
  // Count and drain stderr without retaining native diagnostics or user content.
  child.stderr.on('data', (chunk: Buffer) => { acceptBytes(chunk) })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  child.stdout.on('data', (chunk: Buffer) => {
    if (!acceptBytes(chunk)) return
    try {
      carry += decoder.decode(chunk, { stream: true })
      for (let newline; (newline = carry.indexOf('\n')) !== -1;) {
        const line = carry.slice(0, newline)
        carry = carry.slice(newline + 1)
        if (!line.trim()) continue
        const message = object(JSON.parse(line))
        if (!Object.hasOwn(message, 'id')) continue // Notifications never satisfy a read.
        const request = pending.get(message.id as number)
        if (!request || Object.hasOwn(message, 'method')) throw protocolError()
        pending.delete(message.id as number)
        if (Object.hasOwn(message, 'error')) {
          const error = object(message.error)
          request.reject(new AgentMuxError('Native history read request failed.',
            error.code === -32601 ? 'AGENT_SESSION_HISTORY_UNSUPPORTED' : 'AGENT_SESSION_HISTORY_UNAVAILABLE'))
        } else if (Object.hasOwn(message, 'result')) request.resolve(message.result)
        else request.reject(protocolError())
      }
    } catch (error) {
      fail(error instanceof AgentMuxError ? error : protocolError())
    }
  })
  child.stdout.once('end', () => {
    if (failure !== undefined) return
    try {
      carry += decoder.decode()
      if (carry.trim()) throw protocolError()
    } catch (error) {
      fail(error instanceof AgentMuxError ? error : protocolError())
    }
  })
  const request = (method: 'initialize' | 'thread/read' | 'thread/items/list', params: unknown): Promise<unknown> => {
    if (failure !== undefined) return Promise.reject(failure)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
  try {
    await request('initialize', {
      clientInfo: { name: 'agentmux_history', title: 'AgentMux native history', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    const metadata = object(object(await request('thread/read', {
      threadId: context.source.nativeSessionId, includeTurns: false
    })).thread)
    if (metadata.id !== context.source.nativeSessionId) throw new AgentMuxError(
      'Native history metadata belongs to another Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    )
    if (metadata.historyMode !== 'paginated') throw new AgentMuxError(
      'This native Session does not expose indexed history pages.', 'AGENT_SESSION_HISTORY_UNSUPPORTED'
    )
    const result = object(await request('thread/items/list', {
      threadId: context.source.nativeSessionId, limit: context.limit, sortDirection: 'desc',
      ...(context.cursor === undefined ? {} : { cursor: context.cursor })
    }))
    if (!Array.isArray(result.data) || result.data.length > context.limit) throw protocolError()
    if (result.nextCursor !== null && typeof result.nextCursor !== 'string') throw protocolError()
    return { source: { ...context.source }, items: result.data.map(itemEntry).reverse(),
      nextCursor: result.nextCursor as string | null }
  } finally {
    clearTimeout(timer)
    context.signal.removeEventListener('abort', abort)
    // EOF first. A wrapper/native child shares this helper's fresh process group, never an Agent Run.
    child.stdin.end()
    const waitForClose = async (ms: number): Promise<void> => {
      if (exit) return
      let timeout: NodeJS.Timeout | undefined
      await Promise.race([closed, new Promise<void>((resolve) => { timeout = setTimeout(resolve, ms) })])
      if (timeout) clearTimeout(timeout)
    }
    const stopOwnedGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await waitForClose(1_500)
    if (!exit) { stopOwnedGroup('SIGTERM'); await waitForClose(1_000) }
    if (!exit) { stopOwnedGroup('SIGKILL'); await waitForClose(1_000) }
    if (!exit) throw new AgentMuxError('Native history helper could not be reaped.', 'AGENT_SESSION_HISTORY_UNAVAILABLE')
    // A native wrapper can exit while a helper-owned subprocess has already closed its stdio.
    stopOwnedGroup('SIGKILL')
    if (failure !== undefined) throw failure
    if (exit.code !== 0 || exit.signal !== null) {
      throw new AgentMuxError('Native history helper exited unsuccessfully.', 'AGENT_SESSION_HISTORY_UNAVAILABLE')
    }
  }
}
