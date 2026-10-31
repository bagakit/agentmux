import { AgentMuxError } from './errors.js'
import type { AgentMuxHostedClient } from './hosted-client-contract.js'
import type { ExecutionHost } from './execution-host.js'
import { mintObjectId } from './object-id.js'
import type { CommandResult, RunCommandOptions } from './process-runner.js'
import type { AgentMuxRun, AgentMuxRunAttachment } from './types.js'

/** A private Terminal Run protocol, independent of the command's human output. */
const commandScript = `
token=$1; default_cwd=$2; capture_bytes=$3; shift 3
umask 077
directory=$(mktemp -d "\${TMPDIR:-/tmp}/agentmux-command.XXXXXXXX") || exit 125
trap 'rm -rf -- "$directory"' EXIT
trap 'exit 143' HUP INT TERM
stty raw -echo || exit 125
printf '%s:ready\\n' "$token"
: >"$directory/input64"
while IFS= read -r line; do
  [ "$line" = "$token:end" ] && break
  printf '%s' "$line" >>"$directory/input64"
done
base64 -d <"$directory/input64" >"$directory/input" || exit 125
if [ "$default_cwd" = yes ]; then cd -- "$HOME" || exit 125; fi
mkfifo "$directory/outpipe" "$directory/errpipe" || exit 125
head -c "$capture_bytes" <"$directory/outpipe" >"$directory/stdout" & stdout_reader=$!
head -c "$capture_bytes" <"$directory/errpipe" >"$directory/stderr" & stderr_reader=$!
{ "$@" <"$directory/input" >"$directory/outpipe" 2>"$directory/errpipe"; status=$?; } 2>/dev/null
wait "$stdout_reader" "$stderr_reader"
printf '%s:result:%s\\n' "$token" "$status"
base64 <"$directory/stdout" | tr -d '\\r\\n'; printf '\\n'
base64 <"$directory/stderr" | tr -d '\\r\\n'; printf '\\n'
printf '%s:done\\n' "$token"
`

type TerminalPort = Pick<AgentMuxHostedClient, 'prepareTerminal' | 'createPreparedTerminal' | 'attachTerminal' |
  'writeTerminal' | 'readRunReplay' | 'releaseRunAttachment' | 'removeTerminal' | 'stopTerminal' | 'runtimeIdentity' | 'onEvent' | 'dispose'>

/** Transient commands consume existing Core Terminal APIs and the selected Host's RPC transport. */
export class HostedExecutionHost implements ExecutionHost {
  readonly kind = 'ssh' as const
  readonly id: string
  readonly label: string
  private client: Promise<TerminalPort> | undefined
  private disposed = false
  constructor(private readonly options: { id: string; label: string; connect(): Promise<TerminalPort> }) {
    this.id = options.id; this.label = options.label
  }

  async run(command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
    const tokens = ['/usr/bin/env']
    const assignments: string[] = []
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new AgentMuxError('Remote environment name is invalid.', 'INVALID_COMMAND')
      if (value === undefined) tokens.push('-u', key)
      else assignments.push(`${key}=${value}`)
    }
    tokens.push('--', ...assignments, command, ...args)
    if (!command || tokens.some(token => token.includes('\0'))) throw new AgentMuxError('Remote command or argument is invalid.', 'INVALID_COMMAND')
    if (this.disposed) throw new AgentMuxError('This Host command consumer is disposed.', 'CONTROL_CANCELLED')
    options.signal?.throwIfAborted()
    const client = await (this.client ??= this.options.connect().catch(error => { this.client = undefined; throw error }))
    options.signal?.throwIfAborted()
    const createOperationId = mintObjectId(), token = `amux-${mintObjectId()}`, limit = options.maxOutputBytes ?? 8 * 1024 * 1024
    const prepared = await client.prepareTerminal({ createOperationId, workspacePath: options.cwd ?? '/', command: '/bin/sh',
      args: ['-c', commandScript, 'agentmux-command', token, options.cwd === undefined ? 'yes' : 'no', String(limit + 1), ...tokens] })
    options.signal?.throwIfAborted()
    let run: AgentMuxRun | undefined, cursor = 0, inputOperationId: string | undefined
    let opening = true, ended = false, finished = false, attached = false, bytes = 0, confirmed = false, creationSent = false
    let prefix = '', tail = '', finalRead: Promise<void> | undefined
    const pending: Array<{ start: number; data: Uint8Array }> = [], output: Buffer[] = []
    // The helper emits two base64 strings plus a bounded private envelope.
    const encodedLimit = Math.ceil(limit / 3) * 4 + 1024
    let resolveReady!: () => void, resolveDone!: () => void, rejectReady!: (error: Error) => void, rejectDone!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    void ready.catch(() => {}); void done.catch(() => {})
    let timeout: ReturnType<typeof setTimeout> | undefined
    let failedError: AgentMuxError | undefined
    const identityError = (error: unknown) => {
      const cause = error instanceof Error ? error : new Error(String(error))
      const wrapped = new AgentMuxError(cause.message, cause instanceof AgentMuxError ? cause.code : 'COMMAND_UNCONFIRMED',
        JSON.stringify({ createOperationId, ...(run ? { runId: run.runId } : {}), ...(inputOperationId ? { inputOperationId } : {}) }),
        { disposition: creationSent ? 'unknown' : 'not_applied', confirmedInputBytes: null })
      Object.defineProperty(wrapped, 'terminalOperation', { value: { prepared, ...(run ? { run: { runId: run.runId } } : {}) } })
      return wrapped
    }
    const failure = (error: unknown) => {
      if (finished) return
      finished = true
      const wrapped = failedError = identityError(error)
      rejectReady(wrapped); rejectDone(wrapped)
    }
    const text = () => Buffer.concat(output).toString('ascii')
    const check = () => {
      if (prefix.startsWith(`${token}:ready\n`)) resolveReady()
      if (ended && tail.endsWith(`${token}:done\n`)) { finished = true; resolveDone() }
    }
    const accept = (start: number, data: Uint8Array) => {
      if (finished || start + data.byteLength <= cursor) return
      if (start > cursor) { failure(new AgentMuxError('The original command output has a byte Gap. Its Run was retained.', 'COMMAND_OUTPUT_GAP')); return }
      const next = Buffer.from(data.subarray(cursor - start)); cursor = start + data.byteLength; bytes += next.byteLength
      if (bytes > encodedLimit) { failure(new AgentMuxError('Command output exceeded its byte limit.', 'COMMAND_OUTPUT_LIMIT')); void client.stopTerminal(run!).catch(() => {}); return }
      output.push(next)
      if (prefix.length < 256) prefix = (prefix + next.toString('ascii')).slice(0, 256)
      tail = (tail + next.subarray(-256).toString('ascii')).slice(-256)
      check()
    }
    const snapshot = (value: AgentMuxRunAttachment) => {
      if (value.gap) { failure(new AgentMuxError('The original command output has a byte Gap. Its Run was retained.', 'COMMAND_OUTPUT_GAP')); return }
      for (const chunk of value.replay) accept(chunk.startByte, chunk.dataBytes)
      ended ||= value.run.state !== 'running'; check()
    }
    const readFinal = () => {
      if (finalRead || !run || finished) return
      finalRead = client.readRunReplay(run, cursor, 'raw').then(value => {
        snapshot(value)
        if (ended && !finished) failure(new AgentMuxError('The original command ended without a complete result. No command was replayed.', 'COMMAND_UNCONFIRMED'))
      }).catch(failure)
    }
    const unsubscribe = client.onEvent(event => {
      if (!run || finished) return
      if (event.type === 'connection-state' && event.state !== 'restored') failure(new AgentMuxError('The command connection is unconfirmed. Keep its original Run and operation IDs; no command was replayed.', 'COMMAND_UNCONFIRMED'))
      else if ('run' in event && event.run.runId === run.runId) {
        if (event.type === 'terminal-output') {
          const start = event.evidence.outputByteRange.startByte
          if (opening) pending.push({ start, data: event.dataBytes }); else accept(start, event.dataBytes)
        } else if (event.type === 'process-state' && event.state !== 'running') { ended = true; if (!opening) readFinal() }
        else if (event.type === 'attachment-state' && event.state === 'unavailable') failure(new AgentMuxError(event.diagnostic.message, 'COMMAND_UNCONFIRMED'))
        else if (event.type === 'terminal-snapshot' && !opening) snapshot(event)
      }
    })
    const cancel = (code: string, message: string) => {
      failure(new AgentMuxError(message, code))
      if (run) void client.stopTerminal(run).catch(() => {})
    }
    const abort = () => cancel('COMMAND_ABORTED', 'The original command was cancelled; its operation and Run identity were retained.')
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      creationSent = true
      run = await client.createPreparedTerminal(prepared)
      if (options.signal?.aborted) abort()
      if (options.timeoutMs !== undefined) timeout = setTimeout(() => cancel('COMMAND_TIMEOUT', 'The original command timed out; no command was replayed.'), options.timeoutMs)
      const initial = await client.attachTerminal(run.runId, 0, 'raw'); attached = true
      snapshot(initial); opening = false
      for (const event of pending) accept(event.start, event.data)
      pending.length = 0
      if (ended) readFinal()
      await ready
      let expectedByte = initial.run.acceptedInputBytes
      if (expectedByte === null) throw new AgentMuxError('The command input cursor is unconfirmed.', 'CTXMUX_INPUT_CURSOR_MISSING')
      const base64 = Buffer.from(options.input ?? '').toString('base64')
      const parts: string[] = base64.match(/.{1,16384}/gu) ?? []
      parts.push(`${token}:end`)
      for (const part of parts) {
        if (finished) await done
        inputOperationId = mintObjectId()
        const receipt = await client.writeTerminal(run, { ownerInstanceId: client.runtimeIdentity().instanceId,
          operationId: inputOperationId, expectedByte, data: part + '\n' })
        if (receipt.acceptedThroughByte === null) throw new AgentMuxError('The command input receipt is unconfirmed.', 'CTXMUX_INPUT_CURSOR_MISSING')
        expectedByte = receipt.acceptedThroughByte
      }
      await done
      const lines = text().split('\n')
      const match = new RegExp(`^${token}:result:([0-9]+)$`, 'u').exec(lines[1] ?? '')
      if (lines.length !== 6 || lines[0] !== `${token}:ready` || !match || lines[4] !== `${token}:done` ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(lines[2]!) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(lines[3]!)) {
        throw new AgentMuxError('The original command result protocol is incomplete. No command was replayed.', 'COMMAND_UNCONFIRMED')
      }
      const stdout = Buffer.from(lines[2]!, 'base64'), stderr = Buffer.from(lines[3]!, 'base64')
      if (stdout.byteLength + stderr.byteLength > limit) throw new AgentMuxError('Command output exceeded its byte limit.', 'COMMAND_OUTPUT_LIMIT')
      confirmed = true
      return { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: Number(match[1]) }
    } catch (error) {
      failure(error)
      throw failedError ?? identityError(error)
    } finally {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); unsubscribe()
      if (run && attached) await client.releaseRunAttachment(run).catch(() => {})
      // Unknown or live Runs retain their original evidence and recovery path.
      if (run && ended && confirmed) await client.removeTerminal(run).catch(() => {})
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.client?.then(client => client.dispose())
  }
}
