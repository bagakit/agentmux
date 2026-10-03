import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeProcessBirth, nativeProcessFiles, openNativeProcessImage } from '../agent-native-process.js'
import type { AgentProvider, AgentProviderPromptExecutionContext } from '../agent-provider.js'
import type { AgentMuxInteractionRequest, AgentTerminalScreenSnapshot } from '../types.js'

const READ_BYTES = 512 * 1024
type NativeInvocation = { id: string; name: string; arguments: string }
type NativeTarget = { sourceId: string; device: bigint; inode: bigint; invocation?: NativeInvocation }

/** Native source identity and still-outstanding invocation, not a Hook request echo. */
async function readNativeTarget(context: AgentProviderPromptExecutionContext): Promise<NativeTarget | null> {
  const handle = context.nativeHandle
  if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) return null
  const file = await open(handle.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat({ bigint: true })
    if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return null
    const size = Number(stat.size)
    const head = Buffer.alloc(Math.min(size, READ_BYTES))
    await file.read(head, 0, head.length, 0)
    const end = head.indexOf(10)
    if (end < 0) return null
    const meta = JSON.parse(head.subarray(0, end).toString('utf8')) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown } }
    if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) return null
    const sourceId = createHash('sha256').update(`[${JSON.stringify(handle.sessionId)},${stat.dev},${stat.ino}]`).digest('base64url')
    if (context.nativeSourceId && context.nativeSourceId !== sourceId) return null
    const start = Math.max(0, size - READ_BYTES), tail = Buffer.alloc(size - start)
    await file.read(tail, 0, tail.length, start)
    const last = tail.lastIndexOf(10), first = start ? tail.indexOf(10) + 1 : 0
    if (last < 0 || start && first === 0) return { sourceId, device: stat.dev, inode: stat.ino }
    const outstanding = new Map<string, NativeInvocation>()
    for (const line of tail.subarray(first, last).toString('utf8').split('\n')) {
      const row = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> }
      if (row.type !== 'response_item' || !row.payload) continue
      const call = row.payload
      if (typeof call.call_id !== 'string' || !call.call_id) continue
      if (call.type === 'function_call_output') outstanding.delete(call.call_id)
      if (call.type === 'function_call' && typeof call.name === 'string' && typeof call.arguments === 'string') {
        outstanding.set(call.call_id, { id: call.call_id, name: call.name, arguments: call.arguments })
      }
    }
    return { sourceId, device: stat.dev, inode: stat.ino, ...(outstanding.size === 1 ? { invocation: outstanding.values().next().value! } : {}) }
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  } finally { await file.close() }
}

function command(request: AgentMuxInteractionRequest): string | null {
  if (request.kind !== 'permission' || !request.toolInput) return null
  try {
    const input = JSON.parse(request.toolInput) as { cmd?: unknown; command?: unknown }
    const value = request.toolName === 'Bash' ? input.command : input.cmd
    return typeof value === 'string' && value.length > 0 && !/[\r\n]/u.test(value) ? value : null
  } catch { return null }
}

function sameInvocation(target: NativeTarget, request: AgentMuxInteractionRequest): boolean {
  if (request.kind !== 'permission' || !target.invocation || target.invocation.id !== request.nativeToolCallId || !request.toolInput) return false
  try {
    if (request.toolName === 'Bash') {
      const input = JSON.parse(request.toolInput) as Record<string, unknown>
      const args = JSON.parse(target.invocation.arguments) as Record<string, unknown>
      // The authenticated Pre ID binds the complete native invocation. The Hook
      // exposes its shell command and approval justification under different keys.
      return target.invocation.name === 'exec_command' && typeof input.command === 'string' && !!input.command &&
        args.cmd === input.command && Object.keys(input).every(key => ['command', 'description'].includes(key)) &&
        (input.description === undefined || typeof input.description === 'string' && input.description === args.justification)
    }
    if (target.invocation.name !== request.toolName) return false
    // Native and Hook input may differ in key order, but cannot identify different commands or flags.
    const canonical = (text: string): string => JSON.stringify(Object.entries(JSON.parse(text) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    return canonical(target.invocation.arguments) === canonical(request.toolInput)
  } catch { return false }
}

/** Provider-only decoder for the complete current approval pane; ordinary composer never qualifies. */
export function inspectCodexInteractionTarget(screen: AgentTerminalScreenSnapshot, request: AgentMuxInteractionRequest): boolean {
  const cmd = command(request)
  if (!cmd || screen.lines.length !== screen.rows) return false
  const rows = screen.lines.map(line => line.text.trimEnd())
  const footer = rows.findIndex(row => row.trim() === 'Press enter to confirm or esc to cancel')
  if (footer < 0 || screen.cursor.row < footer || screen.cursor.row > footer + 1 ||
      rows.slice(footer + 1).some(row => row.trim())) return false
  let start = -1
  for (let index = 0; index < footer; index++) if (rows[index]!.trim() === 'Would you like to run the following command?') start = index
  if (start < 0) return false
  const pane = rows.slice(start + 1, footer)
  const allow = pane.findIndex(row => /^[› ]*1\. Yes, proceed \(y\)$/u.test(row))
  const reject = pane.findIndex(row => /^[› ]*[23]\. No, and tell Codex what to do differently \(esc\)$/u.test(row))
  if (allow < 0 || reject <= allow) return false
  // Only the exact visible command preceding these options can authorize this invocation.
  return pane.slice(0, allow).some(row => row.trim() === `$ ${cmd}`)
}

export function createCodexInteractionResponsePreparation(
  planResponse: AgentProvider['planInteractionResponse']
): NonNullable<AgentProvider['prepareInteractionResponse']> {
  return async (context, request, response) => {
    if (request.kind !== 'permission' || !request.nativeToolCallId || !command(request) || !context.processId ||
        !Number.isSafeInteger(context.processId) || context.processId <= 0 ||
        context.args.some(arg => arg === '--remote' || arg.startsWith('--remote=')) || context.args.includes('agents')) return null
    const handle = context.nativeHandle
    if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) return null
    const transcriptPath = handle.transcriptPath
    const rootPid = context.processId, rootBirth = await nativeProcessBirth(rootPid, context.signal)
    const handleIdentity = JSON.stringify(context.nativeHandle ?? null)
    let writer: { pid: number; birth: string; image: string } | undefined
    const readCurrentTarget = async (current: AgentProviderPromptExecutionContext): Promise<NativeTarget | null> => {
      const signal = current.signal ?? context.signal
      signal.throwIfAborted()
      if (current.processId !== rootPid || JSON.stringify(current.nativeHandle ?? null) !== handleIdentity ||
          await nativeProcessBirth(rootPid, signal) !== rootBirth) return null
      const target = await readNativeTarget(current)
      if (!target) return null
      const files = (await nativeProcessFiles(rootPid, signal)).filter(entry =>
        entry.path === transcriptPath && entry.device === target.device && entry.inode === target.inode &&
        (entry.access === 'w' || entry.access === 'u'))
      const owners = [...new Set(files.map(entry => entry.processId))]
      if (owners.length !== 1) return null
      const pid = owners[0]!, birth = await nativeProcessBirth(pid, signal), image = await openNativeProcessImage(pid, signal)
      try {
        const candidate = { pid, birth, image: image.identity }
        if (writer && (writer.pid !== pid || writer.birth !== birth || writer.image !== image.identity)) return null
        await image.assertCurrent(signal)
        if (await nativeProcessBirth(pid, signal) !== birth) return null
        writer ??= candidate
      } finally { await image.file.close() }
      return target
    }
    let sourceId: string | undefined
    for (;;) {
      context.signal.throwIfAborted()
      const target = await readCurrentTarget(context)
      if (!target || sourceId && target.sourceId !== sourceId) return null
      sourceId ??= target.sourceId
      if (sameInvocation(target, request)) {
        const expectedSourceId = sourceId
        const inspectCurrentTarget = (screen: AgentTerminalScreenSnapshot): boolean => inspectCodexInteractionTarget(screen, request)
        const frame = await context.observeTarget(inspectCurrentTarget)
        const verifyCurrentTarget = async (current: AgentProviderPromptExecutionContext): Promise<boolean> => {
          const fact = await readCurrentTarget({ ...current, nativeSourceId: expectedSourceId })
          return fact !== null && sameInvocation(fact, request)
        }
        if (!await verifyCurrentTarget(context)) return null
        return { plan: planResponse(request, response), target: { agentSessionId: context.agentSessionId, run: context.run,
          requestId: request.id, nativeToolCallId: request.nativeToolCallId, nativeSourceId: expectedSourceId,
          inputByte: context.inputByte, frame }, inspectCurrentTarget, verifyCurrentTarget }
      }
      await delay(25, undefined, { signal: context.signal })
    }
  }
}
