import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { AgentMuxError, type AgentMuxRpcEndpoint, type AgentMuxRpcCredentials, type AgentMuxRpcParams, type AgentMuxRpcStreamInitial, type AgentMuxRpcStreamEvent } from '@agentmux/core'
import { connectBrowserSdk, BROWSER_RPC_CALL_METHODS, type BrowserSdk } from '@agentmux/core/browser-sdk'

const identity = z.string().min(1).max(128)
function content(result: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, ...(isError ? { isError: true } : {}) }
}
function failure(error: unknown) {
  const e = error instanceof Error ? error : new Error('The original Browser request could not be confirmed.')
  return content({ error: { code: 'code' in e && typeof e.code === 'string' ? e.code : 'BROWSER_ADAPTER_UNAVAILABLE', message: e.message,
    ...(e instanceof AgentMuxError ? { ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.controlFailure ? { controlFailure: e.controlFailure } : {}),
      ...('details' in e && e.details !== undefined ? { details: e.details } : {}), ...('candidates' in e && e.candidates !== undefined ? { candidates: e.candidates } : {}), ...(e.logId ? { logId: e.logId } : {}),
      ...(e.creationFailure ? { creationFailure: e.creationFailure } : {}), ...(e.storageFailure ? { storageFailure: e.storageFailure } : {}) } : {}) } }, true)
}

/** One tool invocation observes an original stream, retaining its initial Gap and exact event sequences. */
async function followWindow(sdk: BrowserSdk, input: { operationId: string; afterSequence?: number; durationMs: number; maxEvents: number }, signal: AbortSignal) {
  let initial: AgentMuxRpcStreamInitial<'browser.follow'> | undefined, bytes = 0, finished = false
  let reason: 'window-ended' | 'event-limit' | 'byte-limit' | 'stream-ended' = 'window-ended'
  let afterSequence = input.afterSequence ?? 0, timer: ReturnType<typeof setTimeout> | undefined
  const events: AgentMuxRpcStreamEvent<'browser.follow'>[] = []
  let resolve!: () => void, reject!: (error: unknown) => void
  const done = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
  const finish = (why: typeof reason, error?: unknown) => {
    if (finished) return
    finished = true; reason = why
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    error === undefined ? resolve() : reject(error)
  }
  const abort = () => finish('stream-ended', new AgentMuxError('This observation was cancelled. The original Browser operation was not stopped.', 'CONTROL_REQUEST_CANCELLED'))
  signal.addEventListener('abort', abort, { once: true })
  // Install rejection handling before any synchronous initial/event callback.
  void done.catch(() => {})
  let subscription: Awaited<ReturnType<BrowserSdk['follow']>> | undefined
  try {
    if (signal.aborted) abort()
    subscription = await sdk.follow({ operationId: input.operationId, ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }) }, {
      signal,
      onInitial: value => { initial = value; if (!finished) timer = setTimeout(() => finish('window-ended'), input.durationMs) },
      onEvent: event => {
        if (finished) return
        const size = Buffer.byteLength(JSON.stringify(event))
        if (bytes + size > 256 * 1024) { finish('byte-limit'); return }
        events.push(event); bytes += size
        if (event.type === 'progress') afterSequence = event.data.sequence
        if (event.type === 'end' || event.type === 'error') finish('stream-ended')
        else if (events.length >= input.maxEvents) finish('event-limit')
      },
      onEnd: error => finish('stream-ended', error)
    })
    await done
    return { ...(initial === undefined ? {} : { initial }), events, afterSequence, observation: reason }
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await subscription?.dispose()
  }
}

/** Uses one explicit endpoint and one original caller. Tool arguments cannot replace either identity. */
export async function createBrowserMcpServer(options: { endpoint: AgentMuxRpcEndpoint; credentials?: AgentMuxRpcCredentials }): Promise<McpServer> {
  const sdk = await connectBrowserSdk(options)
  const server = new McpServer({ name: 'agentmux-browser', version: '0.1.0' })
  server.server.onclose = () => { void sdk.dispose() }
  server.registerTool('browser_discover', { description: 'Read this configured endpoint’s Browser method availability and exact targets; no page is selected automatically.', inputSchema: z.object({}).strict() },
    async (_args, ctx) => {
      try {
        const discovery = await sdk.discover(ctx.mcpReq.signal)
        const targets = await sdk.call('browser.targets', {}, { signal: ctx.mcpReq.signal })
        return content({ ...discovery, targets })
      } catch (error) { return failure(error) }
    })
  server.registerTool('browser_call', { description: 'Invoke an original Browser RPC method with its original params. Supply exact Browser/operation IDs. Caller identity and human approvals cannot be supplied here. Stop uses browser.stop with the original operationId; cancelling this tool does not assert page cancellation.',
    inputSchema: z.object({ method: z.enum(BROWSER_RPC_CALL_METHODS), params: z.record(z.string(), z.unknown()) }).strict() },
    async ({ method, params }, ctx) => {
      // JSON enters the existing typed RPC boundary here; its original service parsers validate business params.
      try { return content({ result: await sdk.call(method, params as AgentMuxRpcParams<typeof method>, { signal: ctx.mcpReq.signal }) }) }
      catch (error) { return failure(error) }
    })
  server.registerTool('browser_follow', { description: 'Observe a bounded window of the original operation stream, preserving initial Gap and event sequences. Window expiry or cancellation ends only this reader; use browser.stop to stop that exact operation.',
    inputSchema: z.object({ operationId: identity, afterSequence: z.number().int().nonnegative().optional(), durationMs: z.number().int().min(1).max(2000).default(250), maxEvents: z.number().int().min(1).max(128).default(16) }).strict() },
    async (input, ctx) => { try { return content(await followWindow(sdk, { operationId: input.operationId, durationMs: input.durationMs, maxEvents: input.maxEvents, ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }) }, ctx.mcpReq.signal)) } catch (error) { return failure(error) } })
  return server
}
