import { AgentContextUsage } from './AgentContextUsage'
import { AgentComposerTools } from './AgentComposerTools'
import type { SessionSnapshot } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { appendFileReferences } from '../lib/composer-file-reference'
import { composerSubmitMode } from '../lib/composer-submit-mode'
import {
  caretAtFirstLine,
  caretAtLastLine,
  emptyHistory,
  navigateHistory,
  recordHistory,
  type HistoryState
} from '../lib/composer-history'
import { isDuplicateResubmit, recordSubmit, RESUBMIT_WINDOW_MS, type LastSubmit } from '../lib/composer-resubmit-guard'
import { useAppStore, type AgentSteerQueueEntry } from '../store'
import { steerEntryTargetsRun, steerQueueCanEverDrain } from '../lib/agent-steer-queue-drain'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { AgentComposer } from './AgentComposer'

export type AgentComposerAvailability = {
  disabled: boolean
  placeholder: string
}

/** One shared identity for "no queue", so the selector returns a stable reference when empty. */
const EMPTY_QUEUE: readonly AgentSteerQueueEntry[] = Object.freeze([])

// Per-session composer state that must NOT live in React: several tests call AgentSessionComposer() as a
// plain function and read its props, which throws on any hook. It also should not live in the Store — that
// file is owned elsewhere right now, and this is renderer-only convenience state (like the queue itself),
// not something Core or persistence needs. Keyed by sessionId so history and the resubmit guard survive a
// composer remount and a switch away-and-back, which is exactly per-session shell-history semantics.
// ponytail: in-memory only — history is lost on app restart, and a dead session leaves a small stale entry
// (same shape the persisted agentNames map already accepts). Cross-restart persistence would need a
// store.ts change; see the report. Upgrade path: move both maps behind a store slice + partialize entry.
const historyBySession = new Map<string, HistoryState>()
const lastSubmitBySession = new Map<string, LastSubmit>()


export function agentComposerAvailability(
  session: SessionSnapshot | undefined,
  forceDisabled = false
): AgentComposerAvailability {
  if (!session || session.kind !== 'agent') {
    return { disabled: true, placeholder: 'Agent is connecting…' }
  }
  if (forceDisabled) {
    return { disabled: true, placeholder: 'Agent is connecting…' }
  }
  if (session.status.state === 'disconnected') {
    return { disabled: true, placeholder: 'Agent is disconnected' }
  }
  if (session.processState !== 'running') {
    return { disabled: true, placeholder: 'Agent is not running' }
  }
  if (session.pendingInteraction) {
    return { disabled: true, placeholder: 'Answer the Agent request above…' }
  }
  return { disabled: false, placeholder: 'Ask, steer, or paste a command…' }
}

export function AgentSessionComposer({
  sessionId,
  disabled = false,
  regionName
}: {
  sessionId: string
  disabled?: boolean
  // 这一格的显示名（含去重编号），由 SessionPane 现算好传进来——它是唯一持有 Region 起点（tabId +
  // regionId + 兄弟格）的宿主。缺席即水印整段不渲染（launcher/PR/board 那些无 Region 的宿主本就不
  // 经这条路走 AgentComposer，此处只透传，不判断）。
  regionName?: string
}) {
  const text = useAppStore((state) => state.agentComposerDrafts[sessionId] ?? '')
  const setAgentComposerDraft = useAppStore((state) => state.setAgentComposerDraft)
  const clearAgentComposerDraftIfUnchanged = useAppStore((state) => state.clearAgentComposerDraftIfUnchanged)
  const enqueueAgentSteer = useAppStore((state) => state.enqueueAgentSteer)
  // The queue entries, not a count — the badge shows the messages, and derives the count from them, so
  // the two cannot drift. Each entry carries an operationId for retry correlation; only its text renders.
  // Falls back to a shared frozen empty array so an absent queue does not hand a fresh `[]` to the
  // selector on every store update (zustand compares by reference) — the `.map` to text happens once per
  // real render below, not inside the selector, so it does not defeat that reference check.
  const queuedEntries = useAppStore((state) => state.agentSteerQueues?.[sessionId] ?? EMPTY_QUEUE)
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  const workspace = useAppStore((state) =>
    state.config?.workspaces.find((item) =>
      session?.kind === 'agent' && workspaceOwnsSessionPath(item, session)
    )
  )
  const activeFile = useAppStore((state) =>
    workspace ? state.lastActiveFileByWorkspace[workspace.id] : undefined
  )
  // The posture control is drawn purely from the Provider's catalog declaration, looked up by the
  // session's providerId. A Provider that declares none yields undefined, so the composer draws nothing.
  const postureControl = useAppStore((state) =>
    session?.kind === 'agent'
      ? state.providerCatalog.find((entry) => entry.id === session.providerId)?.postureControl
      : undefined
  )
  const composerOptions = useAppStore((state) => session?.kind === 'agent'
    ? state.providerCatalog.find((entry) => entry.id === session.providerId)?.composer : undefined)
  const send = useAppStore((state) => state.send)
  const interrupt = useAppStore((state) => state.interrupt)
  const setPosture = useAppStore((state) => state.setPosture)
  const reportError = useAppStore((state) => state.reportError)
  // One decision answers three questions the old `availability + isWorking` pair conflated: can the user
  // type, does the surface permit a submit (true while working — that IS steer), and is the primary button
  // Send or Stop. availability stays for other consumers; this component reads only submitMode.
  const submitMode = composerSubmitMode(session, disabled)

  async function submit(): Promise<void> {
    if (!submitMode.canSubmit || !text.trim()) return
    const value = text
    // 防抖 = identical-submit suppression. Mashing Send with the same text within a short window is an
    // accidental double-tap; drop the second silently. This checks the last SUCCEEDED submit only, and we
    // record below only after send() does NOT throw — so a real "readiness epoch already consumed" failure
    // is never recorded and its retry is never suppressed. Coalescing distinct sends / rate-limiting the
    // agent were rejected: both would swallow messages the user meant to send.
    if (isDuplicateResubmit(lastSubmitBySession.get(sessionId) ?? null, value, Date.now(), RESUBMIT_WINDOW_MS)) return
    try {
      await send(sessionId, value)
      clearAgentComposerDraftIfUnchanged(sessionId, value)
      // Only reached when send() resolved: record for history recall and the resubmit guard.
      lastSubmitBySession.set(sessionId, recordSubmit(value, Date.now()))
      historyBySession.set(sessionId, recordHistory(historyBySession.get(sessionId) ?? emptyHistory, value))
    } catch {
      // The Store owns error presentation; keep the draft available for retry. A codex mid-turn steer that
      // Core refuses (fail-closed readiness) lands here too — the draft staying put is the honest "not
      // sent" signal, and no user turn is recorded because Core throws before it appends one. Nothing is
      // recorded, so the retry the user is about to make is not mistaken for an accidental duplicate.
    }
  }

  // Queue a steer for a working Agent. Unlike send() this cannot fail (it appends to the local queue), so
  // the observability fix lives here: CLEAR THE DRAFT. That is the missing "it entered the queue" signal —
  // the user's words leaving the box, plus the badge count ticking up, is what turns a silent number into
  // an observed event. Same resubmit guard (a double-tap Enter would otherwise queue two identical steers)
  // and the same history recording as the send path.
  function queue(): void {
    const value = text
    if (!value.trim()) return
    if (isDuplicateResubmit(lastSubmitBySession.get(sessionId) ?? null, value, Date.now(), RESUBMIT_WINDOW_MS)) return
    // Clear the draft only once the queue has actually taken the text. A refused enqueue (oversized)
    // must leave the words in the box — the store has already said why, and clearing here would strand
    // the user's message in a banner they cannot copy from.
    if (!enqueueAgentSteer(sessionId, value)) return
    setAgentComposerDraft(sessionId, '')
    lastSubmitBySession.set(sessionId, recordSubmit(value, Date.now()))
    historyBySession.set(sessionId, recordHistory(historyBySession.get(sessionId) ?? emptyHistory, value))
  }

  // Shell-style up/down history recall. The multiline resolution: recall only fires at the line boundary
  // (ArrowUp on the first line, ArrowDown on the last line), so a bare arrow inside a multi-line draft
  // still moves the caret. The reducer preserves the half-typed draft: arrowing up stashes it, arrowing
  // back down to the live position restores it verbatim. Returns the value to place, or null to fall
  // through to caret movement. Everything decidable lives in the two pure lib modules.
  function historyRecall(direction: 'older' | 'newer', draft: string, caret: number): string | null {
    if (direction === 'older' && !caretAtFirstLine(draft, caret)) return null
    if (direction === 'newer' && !caretAtLastLine(draft, caret)) return null
    const result = navigateHistory(historyBySession.get(sessionId) ?? emptyHistory, direction, draft)
    if (!result) return null
    historyBySession.set(sessionId, result.state)
    return result.value
  }


  function addFileReference(): void {
    if (!activeFile || !submitMode.canType) return
    setAgentComposerDraft(sessionId, appendFileReferences(text, [activeFile]))
  }

  async function attachFiles(): Promise<void> {
    if (!submitMode.canType) return
    const workspacePath = session?.kind === 'agent' ? session.workspacePath : undefined
    try {
      const chosen = await api.ui.chooseFiles(workspacePath ? { defaultPath: workspacePath } : undefined)
      if (!chosen || chosen.length === 0) return
      // Read the draft at completion, not at click: the dialog is modal but the store is the owner.
      const current = useAppStore.getState().agentComposerDrafts[sessionId] ?? ''
      setAgentComposerDraft(sessionId, appendFileReferences(current, chosen, workspacePath))
    } catch (error) {
      reportError(error)
    }
  }

  async function pasteImage(image: { bytes: Uint8Array; extension: string }): Promise<void> {
    if (!submitMode.canType) return
    // The prompt channel is text with a hard size cap and no Provider speaks ACP, so an image can only
    // reach the Agent as a file it opens itself. Save it, then reference the path like any other file.
    try {
      const path = await api.ui.savePastedImage(image)
      const workspacePath = session?.kind === 'agent' ? session.workspacePath : undefined
      const current = useAppStore.getState().agentComposerDrafts[sessionId] ?? ''
      setAgentComposerDraft(sessionId, appendFileReferences(current, [path], workspacePath))
    } catch (error) {
      // Main refuses an empty image, one over the byte cap, or a failed write. Every one of those is
      // reachable, and each is fired as `void pasteImage(...)` from a paste handler — so without this
      // the rejection is unobserved and the paste just appears to do nothing. Surface it where the
      // sibling actions on this same Composer already surface theirs.
      reportError(error)
    }
  }

  function insertReference(path: string): void {
    const current = useAppStore.getState().agentComposerDrafts[sessionId] ?? ''
    const workspacePath = session?.kind === 'agent' ? session.workspacePath : undefined
    setAgentComposerDraft(sessionId, appendFileReferences(current, [path], workspacePath))
  }
  async function capture(): Promise<void> {
    const path = await api.ui.captureScreenshot()
    if (path) insertReference(path)
  }

  return (
    <AgentComposer
      contextUsage={<AgentContextUsage usage={session?.kind === 'agent' ? session.turnUsage : undefined} />}
      queued={queuedEntries.map((entry) => entry.text)}
      // Read the same fact the store's flush guard reads, through the same predicate — not a second
      // hand-copy of `processState === 'running'`. `steerQueueCanEverDrain` answers "will this queue
      // EVER empty"; the flush guard adds the pendingInteraction gate on top of it, which is the one
      // difference and deliberately not part of this question: a pending interaction also blocks the
      // flush, but `respondInteraction` flushes again as soon as the card is answered, so those entries
      // genuinely are still coming.
      //
      // The runId half is the other precondition. A steer typed at a run that has since been replaced
      // will never be sent (the flush skips it by design), so a live run whose queue still holds entries
      // from a previous run must NOT claim they are on their way.
      queueDeliverable={
        session?.kind === 'agent' &&
        steerQueueCanEverDrain(session.processState) &&
        queuedEntries.every((entry) => steerEntryTargetsRun(entry, session.control.run.runId))
      }
      onCopyQueued={(text) => void copyTextToClipboard(text, reportError)}
      commands={composerOptions?.commands ?? []}
      references={activeFile ? [{ text: `@${activeFile.split('/').at(-1)}`, description: activeFile }] : []}
      onSelectSuggestion={(item, kind) => { if (kind === 'reference' && activeFile) addFileReference() }}
      tools={<AgentComposerTools disabled={!submitMode.canType} commands={composerOptions?.commands ?? []}
        loadSkills={() => api.ui.listAgentSkills(sessionId)} onChooseSkill={(skill) => insertReference(skill.path)}
        onCommand={(command) => {
          const current = useAppStore.getState().agentComposerDrafts[sessionId] ?? ''
          setAgentComposerDraft(sessionId, `${command}${current ? ` ${current}` : ' '}`)
        }} {...(session?.hostId === 'local' ? { onCapture: capture } : {})} reportError={reportError} />}
      value={text}
      disabled={!submitMode.canType}
      placeholder={submitMode.placeholder}
      primaryAction={submitMode.primaryAction}
      onHistoryRecall={historyRecall}
      {...(regionName ? { regionName } : {})}
      {...(activeFile ? { activeFile } : {})}
      {...(postureControl ? { postureControl } : {})}
      onChange={(value) => setAgentComposerDraft(sessionId, value)}
      // Interrupt rides `primaryAction`, NOT `canSubmit`. They answer different questions and
      // composer-submit-mode.ts keeps them apart on purpose ("Stop … independent of `canSubmit`"); wiring
      // Interrupt into the submit spread collapsed them again. The state that exposed it: a `working`
      // Agent with a pending permission card has `canSubmit:false` while `primaryAction` stays `'stop'`,
      // so the ■ button rendered with `onInterrupt` undefined — `disabled={disabled || !onInterrupt}` —
      // and the only UI path to interrupt a turn was dead exactly when a card was up.
      //
      // 原则 11 第 2 类: the daemon never stopped honouring it. store.interrupt → runtime.interrupt →
      // client.signalAgent → kernel.interrupt(runId) carries no pendingInteraction gate and no
      // processState gate — contrast writeAgentInput, which deliberately DOES throw
      // AGENT_INTERACTION_PENDING. So this took away an ability the runtime still has: RED-LINES.md
      // 判定流程 "绕过我这段代码，这条路还能不能通？→ 能" ⇒ red line.
      {...(submitMode.primaryAction === 'stop' ? { onInterrupt: () => void interrupt(sessionId) } : {})}
      // Draft-building helpers follow `canType`, which is what their own bodies already check
      // (attachFiles/pasteImage/addFileReference each return early on `!canType`). Gating them on
      // canSubmit contradicted those guards: while a card is pending the placeholder invites "Draft a
      // steer…" yet attach/paste/@-file were withheld from the draft the user is allowed to type.
      // These three only edit the local draft — nothing leaves the renderer — so a pending card is
      // irrelevant to them.
      {...(submitMode.canType ? {
        onAttach: () => void attachFiles(),
        onPasteImage: (image: { bytes: Uint8Array; extension: string }) => void pasteImage(image),
        ...(activeFile ? { onReferenceActiveFile: addFileReference } : {})
      } : {})}
      // Posture and submit share one gate because they are literally the same write.
      // `client.setAgentPosture` resolves the Provider's keystroke and then calls `writeAgentInput` —
      // the very function that throws AGENT_INTERACTION_PENDING while a card is up. So this is 原则 11
      // 第 1 类 (the capability is genuinely gone), not 第 2 类: "绕过我这段代码，这条路还能不能通？→
      // 不能". Withholding it is the honest surface; offering it would render a picker whose every
      // click earns an error banner.
      //
      // An earlier pass grouped posture with the draft helpers on the claim that "setAgentPosture does
      // not depend on submit readiness". That was wrong — it never read past the keystroke lookup to
      // the write. `canSubmit` is not a coincidental proxy here: canSubmit ≡ canType && no pending
      // card ≡ exactly writeAgentInput's own precondition. The test pins that equivalence, so the day
      // canSubmit grows a condition writeAgentInput does not share, it reds instead of drifting.
      {...(submitMode.canSubmit ? {
        onSubmit: () => void submit(),
        ...(postureControl ? { onSetPosture: (modeId: string) => void setPosture(sessionId, modeId) } : {})
      } : {})}
      {...(session?.kind === 'agent' && text.trim() && (session.pendingInteraction || submitMode.primaryAction === 'stop') ? {
        onQueue: () => queue()
      } : {})}
    />
  )
}
