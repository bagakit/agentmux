import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentProviderPromptExecutionContext, AgentProviderPromptPayloadConsumption } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { nativeProcessBirth } from '../agent-native-process.js'
import { discoverCursorNativeSession } from './cursor-native-session.js'
import { resolveCursorStorePath } from './cursor-history.js'
import { qualifyCursorPayloadProtocol } from './cursor-payload-protocol.js'

function unavailable(): never {
  throw new AgentMuxError('The original native payload source is unconfirmed.', 'AGENT_PROMPT_PAYLOAD_CONSUMPTION_UNCONFIRMED')
}

async function source(context: AgentProviderPromptExecutionContext): Promise<{ id: string; path: string }> {
  const handle = context.nativeHandle, signal = context.signal ?? new AbortController().signal
  if (!context.processId || !context.command || handle?.kind !== 'provider' || handle.providerId !== 'cursor') unavailable()
  signal.throwIfAborted()
  const protocol = await qualifyCursorPayloadProtocol(context)
  const path = await realpath(await resolveCursorStorePath(context.workspacePath, handle.sessionId, context.env))
  const witness = await discoverCursorNativeSession({ workspacePath: context.workspacePath, processId: context.processId, command: context.command, args: context.args,
    env: context.env ?? {}, signal })
  if (!witness?.handle || !witness.assertCurrent || witness.handle.sessionId !== handle.sessionId || !witness.handle.transcriptPath || await realpath(witness.handle.transcriptPath) !== path ||
      handle.transcriptPath !== undefined && await realpath(handle.transcriptPath) !== path) unavailable()
  const birth = await nativeProcessBirth(context.processId, signal)
  const [db, directory] = await Promise.all([stat(path, { bigint: true }), stat(dirname(path), { bigint: true })])
  await witness.assertCurrent()
  const id = createHash('sha256').update(JSON.stringify(['cursor-native-paste-v1', protocol, context.processId, birth,
    path, handle.sessionId, String(db.dev), String(db.ino), String(directory.dev), String(directory.ino)])).digest('base64url')
  return { id, path: join(dirname(path), 'pasted_text.json') }
}

async function entries(path: string): Promise<Map<number, string>> {
  let text: string
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) unavailable()
    text = await file.readFile('utf8')
    const [after, current] = await Promise.all([file.stat({ bigint: true }), stat(path, { bigint: true })])
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new SyntaxError('Native payload data changed during its read.')
    }
  } finally { await file.close() }
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable()
  const record = (value as Record<string, unknown>).entries
  if (!record || typeof record !== 'object' || Array.isArray(record)) unavailable()
  const result = new Map<number, string>()
  for (const [key, body] of Object.entries(record)) {
    const id = Number(key)
    if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== key || typeof body !== 'string') unavailable()
    result.set(id, body)
  }
  return result
}

/**
 * Cursor 2026.11.05 PromptBar persists complete pastes longer than 800 UTF-16 chars
 * as {entries:{positiveId: originalBody}} beside the original native store.db.
 * This machine-owned body record is independent of its rendered placeholder.
 * The text-input hook interprets Return during its third <35ms callback as a
 * pasted newline. Core therefore starts that protocol interval only after this
 * exact new body record, and keeps Enter in its original separate phase.
 */
export const cursorPromptPayloadConsumption: AgentProviderPromptPayloadConsumption = {
  async prepare(context, text) {
    if (text.length <= 800) unavailable()
    const original = await source(context)
    const baseline = await entries(original.path)
    if ((await source(context)).id !== original.id) unavailable()
    return { sourceId: original.id, baselineId: String(Math.max(0, ...baseline.keys())) }
  },
  async read(context, original, text) {
    if (text.length <= 800 || !/^(0|[1-9][0-9]*)$/.test(original.baselineId) || !Number.isSafeInteger(Number(original.baselineId))) unavailable()
    const current = await source(context)
    if (current.id !== original.sourceId) unavailable()
    let observed: Map<number, string>
    try { observed = await entries(current.path) } catch (error) {
      // Cursor overwrites this file asynchronously; an incomplete JSON write is
      // an observation gap, never permission to submit or repeat the payload.
      if (error instanceof SyntaxError) return null
      throw error
    }
    if ((await source(context)).id !== original.sourceId) unavailable()
    const matches = [...observed].filter(([id, body]) => id > Number(original.baselineId) && body === text)
    if (matches.length !== 1) return null
    const receiptId = String(matches[0]![0])
    return original.receipt && original.receipt.id !== receiptId ? null : { receiptId }
  }
}
