import { AgentContextUsage } from './AgentContextUsage'
import { AgentComposerTools } from './AgentComposerTools'
import type { SessionSnapshot } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { appendFileReferences } from '../lib/composer-file-reference'
import { composerSubmitMode } from '../lib/composer-submit-mode'
import { useAppStore } from '../store'
import { AgentComposer } from './AgentComposer'

export type AgentComposerAvailability = {
  disabled: boolean
  placeholder: string
}

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
  disabled = false
}: {
  sessionId: string
  disabled?: boolean
}) {
  const text = useAppStore((state) => state.agentComposerDrafts[sessionId] ?? '')
  const setAgentComposerDraft = useAppStore((state) => state.setAgentComposerDraft)
  const clearAgentComposerDraftIfUnchanged = useAppStore((state) => state.clearAgentComposerDraftIfUnchanged)
  const enqueueAgentSteer = useAppStore((state) => state.enqueueAgentSteer)
  const queuedCount = useAppStore((state) => state.agentSteerQueues?.[sessionId]?.length ?? 0)
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
    try {
      await send(sessionId, value)
      clearAgentComposerDraftIfUnchanged(sessionId, value)
    } catch {
      // The Store owns error presentation; keep the draft available for retry. A codex mid-turn steer that
      // Core refuses (fail-closed readiness) lands here too — the draft staying put is the honest "not
      // sent" signal, and no user turn is recorded because Core throws before it appends one.
    }
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
      queuedCount={queuedCount}
      commands={composerOptions?.commands ?? []}
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
      {...(activeFile ? { activeFile } : {})}
      {...(postureControl ? { postureControl } : {})}
      onChange={(value) => setAgentComposerDraft(sessionId, value)}
      {...(submitMode.canSubmit ? {
        onSubmit: () => void submit(),
        onInterrupt: () => void interrupt(sessionId),
        onAttach: () => void attachFiles(),
        onPasteImage: (image: { bytes: Uint8Array; extension: string }) => void pasteImage(image),
        ...(postureControl ? { onSetPosture: (modeId: string) => void setPosture(sessionId, modeId) } : {}),
        ...(activeFile ? { onReferenceActiveFile: addFileReference } : {})
      } : {})}
      {...(session?.kind === 'agent' && session.pendingInteraction && text.trim() ? { onQueue: () => enqueueAgentSteer(sessionId, text) } : {})}
    />
  )
}
