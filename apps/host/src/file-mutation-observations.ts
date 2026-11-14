import { AgentMuxError } from '@agentmux/core'
import { fileMutationMatchesScope, parseFileMutationEffect, type FileMutationEffect, type FileReadResource, type FilePathMutationContext } from '@agentmux/core/files'

type Reader = { scope: FileReadResource; context: FilePathMutationContext & { assertCurrent?(): void | Promise<void> };
  effect(effect: FileMutationEffect): void | Promise<void>; end(error?: Error): void | Promise<void>;
  signal: AbortSignal; busy: boolean; closed: boolean; dispose(): void }

/** Ephemeral, bounded observers of this Host's original Files effects. No event history. */
export class FileMutationObservations {
  private readonly readers = new Set<Reader>()
  subscribe(scope: FileReadResource, context: Reader['context'], effect: Reader['effect'], end: Reader['end'], signal: AbortSignal): { start(): void; dispose(): void } {
    const actor = context.actor
    if (!actor || actor.kind === 'agent' && !context.callerHostId) throw new AgentMuxError('The original Files observer transport identity is unavailable.', 'CONTROL_PERMISSION_DENIED')
    const reader: Reader = { scope: structuredClone(scope), context: { ...context, actor: { ...actor } }, effect, end, signal, busy: false, closed: false,
      dispose: () => { if (reader.closed) return; reader.closed = true; this.readers.delete(reader); signal.removeEventListener('abort', reader.dispose) } }
    signal.addEventListener('abort', reader.dispose, { once: true })
    if (signal.aborted) reader.dispose()
    // The RPC owner starts only after its opening response has reached the reader.
    return { start: () => { if (!reader.closed && !signal.aborted) this.readers.add(reader) }, dispose: reader.dispose }
  }
  private fail(reader: Reader, cause: unknown): void {
    if (reader.closed) return
    reader.dispose()
    // At most one terminal notification; never queue subsequent effects behind a slow reader.
    try { void Promise.resolve(reader.end(cause instanceof Error ? cause : new Error(String(cause)))).catch(() => {}) } catch { /* Reader is already detached. */ }
  }
  publish(raw: FileMutationEffect, provenance?: FilePathMutationContext): void {
    let owned: FileMutationEffect | undefined, failure: unknown
    try { owned = structuredClone(parseFileMutationEffect(raw)) } catch (cause) { failure = cause }
    for (const reader of this.readers) {
      if (reader.closed || !fileMutationMatchesScope(raw, reader.scope)) continue
      const actor = reader.context.actor!
      // A display/resource Host alias never substitutes for original caller provenance.
      if (actor.kind === 'agent' && (provenance?.actor?.kind !== actor.kind || provenance.actor.id !== actor.id || !provenance.callerHostId || provenance.callerHostId !== reader.context.callerHostId)) continue
      if (!owned) { this.fail(reader, failure); continue }
      if (reader.busy) { this.fail(reader, new AgentMuxError('Files live observation overflowed. Keep the original requests and inspect their operations; no effect was replayed.', 'FILE_MUTATION_OBSERVATION_GAP')); continue }
      reader.busy = true
      const event = structuredClone(owned)
      void Promise.resolve().then(async () => {
        reader.signal.throwIfAborted(); await reader.context.assertCurrent?.(); reader.signal.throwIfAborted()
        if (!reader.closed) await reader.effect(event)
      }).catch(cause => this.fail(reader, cause)).finally(() => { reader.busy = false })
    }
  }
}
