import { spawn } from 'node:child_process'
import { AgentMuxError } from '../errors.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS } from '../session-history.js'
import type { AgentProviderSessionHistoryContext } from '../types.js'

export type CodexNativeReadContext = Pick<AgentProviderSessionHistoryContext, 'command' | 'args' | 'workspacePath' | 'env' | 'signal'>
type ReadMethod = 'initialize' | 'thread/read' | 'thread/items/list' | 'hooks/list'
type ReadPurpose = 'history' | 'hooks'

function protocolError(purpose: ReadPurpose): AgentMuxError {
  return new AgentMuxError('Native read returned an invalid protocol response.', purpose === 'history'
    ? 'INVALID_AGENT_SESSION_HISTORY_PAGE' : 'INVALID_AGENT_HOOK_RESPONSE')
}
function object(value: unknown, purpose: ReadPurpose): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError(purpose)
  return value as Record<string, unknown>
}
function code(purpose: ReadPurpose, suffix: string): string {
  return `${purpose === 'history' ? 'AGENT_SESSION_HISTORY' : 'AGENT_HOOK_READ'}_${suffix}`
}

/** One bounded private native reader; the method union excludes thread/turn mutation and trust writes. */
export async function withCodexNativeRead<T>(
  context: CodexNativeReadContext,
  purpose: ReadPurpose,
  read: (request: (method: ReadMethod, params: unknown) => Promise<unknown>) => Promise<T>
): Promise<T> {
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
  const closed = new Promise<void>((resolve) => child.once('close', (exitCode, signal) => {
    exit = { code: exitCode, signal }
    if (pending.size) fail(new AgentMuxError(
      'The native read helper closed before the page completed.', code(purpose, 'UNAVAILABLE')
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
    'Native read timed out.', code(purpose, 'TIMEOUT')
  )), SESSION_HISTORY_TIMEOUT_MS)
  child.once('error', () => fail(new AgentMuxError(
    'The configured native read helper could not start.', code(purpose, 'UNAVAILABLE')
  )))
  child.stdin.on('error', () => fail(new AgentMuxError(
    'Native read request could not be sent.', code(purpose, 'UNAVAILABLE')
  )))
  const acceptBytes = (chunk: Buffer): boolean => {
    receivedBytes += chunk.byteLength
    if (receivedBytes <= SESSION_HISTORY_MAX_PAGE_BYTES) return failure === undefined
    fail(new AgentMuxError('Native read response exceeds its byte budget.', code(purpose, 'TOO_LARGE')))
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
        const message = object(JSON.parse(line), purpose)
        if (!Object.hasOwn(message, 'id')) continue // Notifications never satisfy a read.
        const request = pending.get(message.id as number)
        if (!request || Object.hasOwn(message, 'method')) throw protocolError(purpose)
        pending.delete(message.id as number)
        if (Object.hasOwn(message, 'error')) {
          const error = object(message.error, purpose)
          request.reject(new AgentMuxError('Native read request failed.',
            error.code === -32601 ? code(purpose, 'UNSUPPORTED') : code(purpose, 'UNAVAILABLE')))
        } else if (Object.hasOwn(message, 'result')) request.resolve(message.result)
        else request.reject(protocolError(purpose))
      }
    } catch (error) {
      fail(error instanceof AgentMuxError ? error : protocolError(purpose))
    }
  })
  child.stdout.once('end', () => {
    if (failure !== undefined) return
    try {
      carry += decoder.decode()
      if (carry.trim()) throw protocolError(purpose)
    } catch (error) {
      fail(error instanceof AgentMuxError ? error : protocolError(purpose))
    }
  })
  const request = (method: ReadMethod, params: unknown): Promise<unknown> => {
    if (!['initialize', 'thread/read', 'thread/items/list', 'hooks/list'].includes(method)) return Promise.reject(protocolError(purpose))
    if (failure !== undefined) return Promise.reject(failure)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
  try {
    await request('initialize', {
      clientInfo: { name: 'agentmux_native_read', title: 'AgentMux native reader', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    return await read(request)
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
    if (!exit) throw new AgentMuxError('Native read helper could not be reaped.', code(purpose, 'UNAVAILABLE'))
    // A native wrapper can exit while a helper-owned subprocess has already closed its stdio.
    stopOwnedGroup('SIGKILL')
    if (failure !== undefined) throw failure
    if (exit.code !== 0 || exit.signal !== null) {
      throw new AgentMuxError('Native read helper exited unsuccessfully.', code(purpose, 'UNAVAILABLE'))
    }
  }
}
