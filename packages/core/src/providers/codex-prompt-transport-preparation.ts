import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeProcessBirth, nativeProcessFiles, openNativeProcessImage } from '../agent-native-process.js'
import type { AgentProvider, AgentProviderPromptExecutionContext } from '../agent-provider.js'
import { readCodexPromptExecutionEvidence } from './codex-prompt-execution-evidence.js'

/** Startup eligibility is observed before any key/input. The one-shot verifier remains mandatory. */
export function createCodexPromptTransportPreparation(
  verify: NonNullable<AgentProvider['verifyPromptExecutionTransport']>
): NonNullable<AgentProvider['preparePromptExecutionTransport']> {
  return async context => {
    const handle = context.nativeHandle
    if (context.args.some(arg => arg === '--remote' || arg.startsWith('--remote=')) || context.args.includes('agents') ||
        !context.processId || !Number.isSafeInteger(context.processId) || context.processId <= 0 || !context.nativeSourceId ||
        handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) return null
    const rootPid = context.processId, sourceId = context.nativeSourceId, path = handle.transcriptPath
    const rootBirth = await nativeProcessBirth(rootPid, context.signal)
    let writer: { pid: number; birth: string; image: string } | undefined
    const readWriter = async (current: AgentProviderPromptExecutionContext): Promise<'pending' | 'current' | 'changed'> => {
      current.signal?.throwIfAborted()
      if (current.processId !== rootPid || JSON.stringify(current.nativeHandle) !== JSON.stringify(handle) ||
          current.nativeSourceId !== sourceId || await nativeProcessBirth(rootPid, current.signal ?? context.signal) !== rootBirth) return 'changed'
      const evidence = await readCodexPromptExecutionEvidence(current)
      if (!evidence || evidence.sourceId !== sourceId) return 'changed'
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let source
      try { source = await file.stat({ bigint: true }) } finally { await file.close() }
      const files = (await nativeProcessFiles(rootPid, current.signal ?? context.signal)).filter(entry => entry.path === path &&
        entry.device === source.dev && entry.inode === source.ino && (entry.access === 'w' || entry.access === 'u'))
      const owners = [...new Set(files.map(entry => entry.processId))]
      if (owners.length > 1) return 'changed'
      if (owners.length === 0) return writer ? 'changed' : 'pending'
      const signal = current.signal ?? context.signal
      const pid = owners[0]!, birth = await nativeProcessBirth(pid, signal)
      const image = await openNativeProcessImage(pid, signal)
      try {
        const candidate = { pid, birth, image: image.identity }
        if (writer && (writer.pid !== candidate.pid || writer.birth !== candidate.birth || writer.image !== candidate.image)) return 'changed'
        await image.assertCurrent(signal)
        if (await nativeProcessBirth(pid, signal) !== birth) return 'changed'
        writer ??= candidate
      } finally { await image.file.close() }
      return 'current'
    }
    for (;;) {
      context.signal.throwIfAborted()
      const state = await readWriter(context)
      if (state === 'changed') return null
      if (state === 'current' && await verify(context)) {
        // Retain only this preparation's identity, never a reusable true/authorization cache.
        return { nativeSourceId: sourceId, verifyCurrentTransport: async current => {
          if (await readWriter(current) !== 'current' || !await verify(current)) return false
          return await readWriter(current) === 'current'
        } }
      }
      await delay(50, undefined, { signal: context.signal })
    }
  }
}
