import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { nativeProcessFiles, nativeProcessBirth } from '../agent-native-process.js'
import type { AgentProviderPromptExecutionContext } from '../agent-provider.js'
import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { codexNativeSourceId, readCodexPromptExecutionEvidence as readNativeEvidence } from '@agentmux/providers/codex/turn-evidence'

const HEADER_BYTES = 512 * 1024
export const readCodexPromptExecutionEvidence: NonNullable<AgentProvider['readPromptExecutionEvidence']> = readNativeEvidence

/** Only this negative observation may retain the startup loop's existing wait. */
export class CodexPromptTransportUnconfirmedError extends AgentMuxError {
  constructor(context: AgentProviderPromptExecutionContext, reason: string, ownerCount?: number) {
    super('The native input transport is unconfirmed.', 'AGENT_PROMPT_IMMEDIATE_TRANSPORT_UNCONFIRMED',
      JSON.stringify({ providerId: 'codex', reason,
        ...(Number.isSafeInteger(context.processId) && context.processId! > 0 ? { processId: context.processId } : {}),
        ...(context.nativeSourceId && /^[A-Za-z0-9_-]{43}$/u.test(context.nativeSourceId) ? { nativeSourceId: context.nativeSourceId } : {}),
        ...(ownerCount === undefined ? {} : { ownerCount }) }))
  }
}

/** Current local transport is proven by the exact native source's unique writer
 * in this Run's process group. Executable path/version observations are separate:
 * removing a mapped pathname cannot change this current input capability.
 * The caller still requires the supported complete current native pane and turn
 * through inspectPromptExecution/readPromptExecutionEvidence before input.
 */
export function createCodexPromptExecutionTransportVerifier(): (context: AgentProviderPromptExecutionContext) => Promise<boolean> {
  return async (context) => {
    const unconfirmed: (reason: string, ownerCount?: number) => never = (reason, ownerCount) => {
      throw new CodexPromptTransportUnconfirmedError(context, reason, ownerCount)
    }
    if (context.args.some(arg => arg === '--remote' || arg.startsWith('--remote=')) || context.args.includes('agents')) unconfirmed('unsupported-launch')
    if (!context.processId || !Number.isSafeInteger(context.processId) || context.processId <= 0) unconfirmed('runtime-process-unavailable')
    const handle = context.nativeHandle
    if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) unconfirmed('native-handle-unavailable')
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000)
    const file = await open(handle.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let source
    try {
      source = await file.stat({ bigint: true })
      if (!source.isFile()) unconfirmed('native-source-not-file')
      if (!context.nativeSourceId || codexNativeSourceId(handle.sessionId, source) !== context.nativeSourceId) unconfirmed('native-source-mismatch')
      const header = Buffer.alloc(Number(source.size < BigInt(HEADER_BYTES) ? source.size : BigInt(HEADER_BYTES)))
      await file.read(header, 0, header.length, 0)
      const end = header.indexOf(10)
      if (end < 0) unconfirmed('native-header-incomplete')
      const meta = JSON.parse(header.subarray(0, end).toString('utf8')) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown } }
      // Resume appends to the creator's rollout. Its version is historical metadata.
      if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) unconfirmed('native-header-mismatch')
    } finally { await file.close() }
    const rootBirth = await nativeProcessBirth(context.processId, signal)
    const matches = (await nativeProcessFiles(context.processId, signal)).filter(file => file.path === handle.transcriptPath &&
      file.device === source.dev && file.inode === source.ino && (file.access === 'w' || file.access === 'u'))
    const owners = [...new Set(matches.map(file => file.processId))]
    if (owners.length !== 1) unconfirmed(owners.length === 0 ? 'native-source-writer-missing' : 'native-source-writer-ambiguous', owners.length)
    const nativePid = owners[0]!
    const nativeBirth = await nativeProcessBirth(nativePid, signal)
    const after = (await nativeProcessFiles(context.processId, signal)).filter(file =>
      file.path === handle.transcriptPath && file.device === source.dev && file.inode === source.ino && (file.access === 'w' || file.access === 'u'))
    const afterOwners = [...new Set(after.map(file => file.processId))]
    if (afterOwners.length !== 1 || afterOwners[0] !== nativePid) unconfirmed('native-source-writer-changed', afterOwners.length)
    if (!after.some(file => matches.some(old => old.processId === file.processId && old.descriptor === file.descriptor))) unconfirmed('native-writer-descriptor-changed')
    if (await nativeProcessBirth(context.processId, signal) !== rootBirth) unconfirmed('runtime-process-changed')
    if (await nativeProcessBirth(nativePid, signal) !== nativeBirth) unconfirmed('native-writer-process-changed')
    if ((await readCodexPromptExecutionEvidence({ ...context, signal }))?.sourceId !== context.nativeSourceId) unconfirmed('native-evidence-mismatch')
    return true
  }
}
