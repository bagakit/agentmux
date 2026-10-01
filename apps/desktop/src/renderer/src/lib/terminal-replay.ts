import type { AgentMuxRunState, AgentMuxTerminalContinuation } from '@agentmux/core'
import type { SessionReplayResult } from '../../../shared/contracts'
import { TERMINAL_REVEAL_DEADLINE_MS } from './terminal-reveal'
import { agentViabilityFromProcessState, type StepOutcome } from './service-window-notice'

export type TerminalContinuationAbsence = Extract<AgentMuxTerminalContinuation, { type: 'unknown' | 'unavailable' }> & { duringReconnect?: boolean }

export function terminalContinuationOutcome(absence: TerminalContinuationAbsence | null, processState: AgentMuxRunState): StepOutcome {
  if (!absence) return { completed: true }
  const reasons: Record<TerminalContinuationAbsence['reason'], string> = {
    origin_unknown: 'The Runtime did not observe this terminal from its origin.',
    source_gap: 'The Runtime cannot prove continuous terminal state across a source gap.',
    tail_evicted: 'The bytes needed after the checkpoint are no longer retained.',
    checkpoint_too_large: 'The terminal checkpoint exceeds the Runtime size limit.',
    invalid_checkpoint: 'The Runtime could not validate the terminal checkpoint.'
  }
  return {
    completed: false,
    agentViability: agentViabilityFromProcessState(processState),
    step: {
      label: 'Restoring terminal state',
      degradedMode: absence.duringReconnect
        ? `${reasons[absence.reason]} Terminal state could not be continued across the disconnection. The existing display may be incomplete; live input remains available while the Run is healthy.`
        : `${reasons[absence.reason]} Retained bytes remain readable, but earlier history and input modes cannot be confirmed. Live input remains available while the Run is healthy.`,
      restore: 'Reopening retries the Runtime checkpoint. Lost origin or evicted bytes cannot be reconstructed from a later repaint.'
    }
  }
}

export function terminalReplayGeometryOutcome(unknown: boolean, processState: AgentMuxRunState): StepOutcome {
  if (!unknown) return { completed: true }
  return {
    completed: false,
    agentViability: agentViabilityFromProcessState(processState),
    step: {
      label: 'Confirming replay geometry',
      degradedMode: 'The terminal remains available. Retained output may have an incorrect layout because its size is unknown.',
      restore: 'Viewport synchronization requests a repaint of the current screen. Resize the pane to retry; historical layout cannot be confirmed.'
    }
  }
}

export function terminalViewportSyncOutcome(failed: boolean, processState: AgentMuxRunState): StepOutcome {
  if (!failed) return { completed: true }
  return {
    completed: false,
    agentViability: agentViabilityFromProcessState(processState),
    step: {
      label: 'Synchronizing terminal size',
      degradedMode: 'The terminal remains available, but the Runtime has not confirmed the requested screen size.',
      restore: 'Resize the pane or return to this tab to retry. This notice clears when the Runtime confirms the resize.'
    }
  }
}

/** A history read is optional recovery work; it cannot hold a healthy live pane indefinitely. */
export function boundedTerminalHistoryRead(read: Promise<SessionReplayResult>): Promise<SessionReplayResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Retained history read timed out; Runtime history availability is unknown.')), TERMINAL_REVEAL_DEADLINE_MS)
    // Keep rejection observed after the deadline. Core owns the transient Attachment's cleanup;
    // RuntimeController refuses another read for this Run until this operation actually settles.
    void read.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/**
 * Crosses the replay-to-live boundary in one fixed order. Gap redraw is last:
 * a TUI repaint must not race retained replay or the startup live buffer.
 */
export async function finishTerminalReplayRecovery(options: {
  gap: boolean
  canControlRun: boolean
  startLiveSynchronization(): Promise<void>
  releaseLiveOutput(): Promise<void>
  finishReplay(): void
  redrawCurrentScreen(): Promise<boolean>
  onRedrawError?(error: unknown): void
  onRecoveryError?(error: unknown): void
}): Promise<boolean> {
  // Release the startup buffer before resize/fit. Resize crosses the same per-Run
  // serialization boundary as attach; waiting for it first can leave a visible but
  // permanently frozen terminal when that optional sync is the step that stalled.
  try {
    await options.releaseLiveOutput()
  } catch (error) {
    options.onRecoveryError?.(error)
  } finally {
    // The startup bytes were rendered at the attachment's size too. Unlock only after their
    // drain settles, including failed drains and historical Runs that cannot resize a PTY.
    options.finishReplay()
  }
  if (options.canControlRun) {
    try {
      await options.startLiveSynchronization()
    } catch (error) {
      // Attach and replay already succeeded. A viewport-sync failure is a local
      // recovery degradation, not an attach failure and must not replace the pane.
      options.onRecoveryError?.(error)
    }
  }
  if (!options.gap || !options.canControlRun) return false
  try {
    return await options.redrawCurrentScreen()
  } catch (error) {
    options.onRedrawError?.(error)
    return false
  }
}
