import type { SessionSnapshot } from '../../../shared/contracts'

/**
 * The three questions the Composer must keep apart. Conflating them into one `!isWorking` boolean is the
 * bug this module exists to kill: today a single flag decides both "does Enter submit" and "is the primary
 * action Send or Stop", so a running Agent — which can be *both* steered and stopped — could only be
 * stopped.
 *
 * - `canType`     — is the textarea writable at all? Mirrors {@link agentComposerAvailability} item-for-item.
 * - `canSubmit`   — does the surface permit a submit attempt? True while `working`, so a mid-turn steer
 *                   goes out, and true while a request card is pending: the caller queues that submit
 *                   until the request ends instead of taking Send away. Whether the draft
 *                   is non-empty is a separate UI concern the Composer ANDs in — this answers session state
 *                   only. It never predicts whether Core will *accept* the prompt (codex may fail-closed
 *                   mid-turn); it answers "does the interface allow submitting", delivery stays Core's call.
 * - `primaryAction` — Send or Stop. `stop` while `working`, independent of `canSubmit`: a turn in flight
 *                   must always be interruptible, and that is a different question from whether Enter sends.
 */
export type ComposerSubmitMode = {
  canType: boolean
  canSubmit: boolean
  primaryAction: 'send' | 'stop'
  placeholder: string
}

type ComposerSubmitTarget = { kind: 'terminal' } | Pick<Extract<SessionSnapshot, { kind: 'agent' }>, 'kind' | 'processState' | 'pendingInteraction'> & {
  status: Pick<SessionSnapshot['status'], 'state' | 'continuity' | 'continuityReason'>
}

/** Send's name while a request is pending: the message waits in the queue until Core ends that request. */
export const SEND_AFTER_REQUEST_ENDS = 'Send after the Agent request ends'

/**
 * Pure: a Session snapshot and a `forceDisabled` flag in, a decision out. No Store, no Electron, and no
 * `providerId` branching — a Provider's mid-turn readiness is Core's to enforce, not the renderer's to
 * guess. The disabled cases and their placeholders are kept identical to {@link agentComposerAvailability}
 * so the two never disagree about whether the Agent can take input; this only adds the submit/stop axis
 * that availability was never meant to answer.
 */
export function composerSubmitMode(
  session: ComposerSubmitTarget | undefined,
  forceDisabled = false
): ComposerSubmitMode {
  // No Agent yet, or a caller forcing the surface shut: nothing to type into, nothing to send or stop.
  if (!session || session.kind !== 'agent' || forceDisabled) {
    return { canType: false, canSubmit: false, primaryAction: 'send', placeholder: 'Agent is connecting…' }
  }
  if (session.status.state === 'disconnected') {
    return { canType: true, canSubmit: true, primaryAction: 'send', placeholder: 'Send to restore this Agent…' }
  }
  if (session.processState !== 'running') {
    // Core has already answered this Session's recovery with a final fact: there is no native
    // conversation to continue. Send would only replay that refusal, so the draft stays writable and
    // kept while the surface's one primary action starts a new conversation (RED-LINES question 1:
    // the ended Run has no resumable capability left to take away).
    if (session.status.continuity === 'unavailable' && session.status.continuityReason === 'native-conversation-absent') {
      return { canType: true, canSubmit: false, primaryAction: 'send', placeholder: 'Your draft is kept. Start a new conversation above to continue.' }
    }
    return { canType: true, canSubmit: true, primaryAction: 'send', placeholder: 'Send to restore this Agent…' }
  }
  // Deliberately NO `state === 'error'` gate here. A running process whose live OUTPUT channel died
  // (RECONNECT_REATTACH_FAILED, a vanished-handshake run) and one that merely emitted a live-channel
  // advisory (CTXMUX_EVENT_INVALID from an observation_discontinuity / tmux event — the pump keeps
  // running, output keeps flowing) BOTH surface as { state:'error', source:'run-process' }: the reducer
  // drops the code, so this function cannot tell them apart, and it must not try. Both are 原则 11 第 2 类
  // (our observation stumbled, the Agent is fine). The viability question the composer answers is "can the
  // Agent still take bytes?" — and while `processState === 'running'`, input reaches it: writeAgentInput /
  // recoverableInput bypass the output attachment entirely (RED-LINES.md 反例 1). Greying the surface here
  // would take away an ability the daemon still honours — RED-LINES.md 判定流程 "绕过我这段代码，这条路还能
  // 不能通？ → 能" ⇒ red line. Degrade-and-allow: the honest signal for a dead output channel is a service
  // window ("output may not be showing — switch this pane to Activity and back to reattach"), not a locked
  // composer. Deliberately not Resume: on a running Run it returns `reattachable` and never calls attach.
  // The mapping lives in service-window-notice.ts (`terminalOutputChannel.reason === 'reattach-failed'`);
  // this file only decides the composer axes, and deliberately stays out of the notice's wording.
  // `working` drives both axes but answers two questions: Stop stays the primary action AND Enter still
  // submits. Only while working is Stop offered; an idle-running Agent's primary action is Send.
  const primaryAction = session.status.state === 'working' ? 'stop' : 'send'
  // A pending question or permission is a timing fact, not a reason to take Send away. The surface still
  // submits; the store queues that intent unbound until Core settles the exact request. Core's
  // AGENT_INTERACTION_PENDING refusal stays the protocol boundary (RED-LINES question 2: a disabled
  // button here guarded nothing — bare Enter already queued the same message).
  if (session.pendingInteraction) {
    return { canType: true, canSubmit: true, primaryAction, placeholder: 'Answer the Agent request in its card; messages here send after it ends…' }
  }
  return { canType: true, canSubmit: true, primaryAction, placeholder: 'Ask, steer, or paste a command…' }
}
