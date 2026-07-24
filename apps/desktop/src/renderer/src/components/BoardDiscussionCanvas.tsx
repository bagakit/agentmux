import * as Dialog from '@radix-ui/react-dialog'
import {
  Bot,
  GitBranch,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  RadioTower,
  RefreshCw,
  Unlink,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { api } from '../lib/api'
import type { ProjectBranchLane } from '../lib/project-board'
import { agentDetectionKey, useAppStore } from '../store'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'

export function BoardDiscussionCanvas({
  lane,
  anchor,
  onClose,
  onOpenBranches
}: {
  lane: ProjectBranchLane | null
  anchor: WorkspaceRecord
  onClose: () => void
  onOpenBranches: (lane: ProjectBranchLane) => void
}) {
  const config = useAppStore((state) => state.config)
  const detections = useAppStore((state) => state.agentDetections)
  const detectAgents = useAppStore((state) => state.detectAgents)
  const activateWorkspaceSelection = useAppStore((state) => state.activateWorkspaceSelection)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const launchBoardAgent = useAppStore((state) => state.launchBoardAgent)
  const [agentId, setAgentId] = useState('codex')
  const [prompt, setPrompt] = useState('')
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hostId = lane?.workspace?.hostId ?? anchor.hostId
  const agents = useMemo(
    () => Object.keys(config?.agents ?? {}).map((id) => ({
      id,
      label: agentProviderLabel(id),
      detection: detections[agentDetectionKey(hostId, id)]
    })),
    [config?.agents, detections, hostId]
  )
  const installedAgents = agents.filter((agent) => agent.detection?.state === 'ready')
  const unavailableAgents = agents.filter((agent) => agent.detection?.state !== 'ready')
  const detecting = agents.some((agent) => agent.detection?.state === 'checking')
  const canLaunch = Boolean(
    lane?.branch.worktreePath &&
    prompt.trim() &&
    installedAgents.some((agent) => agent.id === agentId)
  )

  useEffect(() => {
    if (!lane) return
    setPrompt('')
    setError(null)
  }, [lane])

  useEffect(() => {
    if (!lane || agents.every((agent) => agent.detection)) return
    void detectAgents(hostId)
  }, [agents, detectAgents, hostId, lane])

  useEffect(() => {
    if (installedAgents.some((agent) => agent.id === agentId)) return
    const first = installedAgents[0]
    if (first) setAgentId(first.id)
  }, [agentId, installedAgents])

  async function startDiscussion(): Promise<void> {
    if (!lane || !canLaunch || launching) return
    setLaunching(true)
    setError(null)
    try {
      let workspace = lane.workspace
      if (!workspace) {
        const result = await api.workspaces.openBranch(anchor.id, lane.branch.name)
        activateWorkspaceSelection(result)
        setMainSurface('board')
        workspace = result.workspace
      }
      await launchBoardAgent(workspace.id, agentId, prompt.trim())
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLaunching(false)
    }
  }

  return (
    <Dialog.Root open={lane !== null} onOpenChange={(open) => !open && !launching && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="discussion-canvas__overlay" />
        <Dialog.Content
          className="discussion-canvas"
          onEscapeKeyDown={(event) => launching && event.preventDefault()}
        >
          <header className="discussion-canvas__header">
            <span className="discussion-canvas__mark"><MessageSquarePlus size={18} /></span>
            <div>
              <div className="eyebrow">Branch inbox</div>
              <Dialog.Title>Discuss {lane?.branch.name ?? 'this Branch'}</Dialog.Title>
              <Dialog.Description>
                Start a real Agent run in this Branch workspace. The run returns to this row.
              </Dialog.Description>
            </div>
            <button type="button" className="icon-button" aria-label="Close discussion canvas" disabled={launching} onClick={onClose}>
              <X size={15} />
            </button>
          </header>

          {lane ? (
            <div className="discussion-canvas__body">
              <section className="discussion-context">
                <span><GitBranch size={14} /></span>
                <div>
                  <strong>{lane.branch.name}</strong>
                  <small title={lane.branch.worktreePath ?? undefined}>{lane.branch.worktreePath ?? 'No worktree'}</small>
                </div>
                <em>{hostId === 'local' ? 'This Mac' : <><RadioTower size={11} /> {hostId}</>}</em>
              </section>

              {!lane.branch.worktreePath ? (
                <section className="discussion-unavailable">
                  <Unlink size={19} />
                  <div>
                    <strong>Create a worktree first</strong>
                    <p>AgentMux will not checkout an unbound Branch implicitly.</p>
                  </div>
                  <button
                    type="button"
                    className="small-button"
                    onClick={() => {
                      onClose()
                      onOpenBranches(lane)
                    }}
                  >
                    Open Branches
                  </button>
                </section>
              ) : (
                <>
                  <section className="discussion-section">
                    <header>
                      <div><span>Provider</span><small>Detected on {hostId === 'local' ? 'this Mac' : hostId}</small></div>
                      <button type="button" className="icon-button" title="Refresh providers" disabled={detecting} onClick={() => void detectAgents(hostId)}>
                        {detecting ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                      </button>
                    </header>
                    <div className="discussion-provider-grid">
                      {installedAgents.map((agent) => (
                        <button
                          type="button"
                          key={agent.id}
                          className={agent.id === agentId ? 'selected' : ''}
                          aria-pressed={agent.id === agentId}
                          onClick={() => setAgentId(agent.id)}
                        >
                          <span><AgentProviderIcon agentId={agent.id} size={22} /></span>
                          <strong>{agent.label}</strong>
                          <small>Ready</small>
                        </button>
                      ))}
                    </div>
                    {unavailableAgents.length > 0 ? (
                      <p className="discussion-provider-unavailable">
                        Not available: {unavailableAgents.map((agent) => agent.label).join(', ')}
                      </p>
                    ) : null}
                  </section>

                  <label className="discussion-prompt">
                    <span>Discussion topic</span>
                    <textarea
                      autoFocus
                      rows={7}
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder="What should the Agent investigate, decide, or change on this Branch?"
                    />
                    <small>The initial prompt is sent through the existing core-owned Agent session.</small>
                  </label>
                </>
              )}
              {error ? <div className="discussion-canvas__error" role="alert">{error}</div> : null}
            </div>
          ) : null}

          <footer className="discussion-canvas__footer">
            <span><Bot size={12} /> Core-owned launch · no Board-only session</span>
            <button type="button" className="small-button" disabled={launching} onClick={onClose}>Cancel</button>
            <button type="button" className="primary-button" disabled={!canLaunch || launching} onClick={() => void startDiscussion()}>
              {launching ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
              {launching ? 'Starting…' : 'Start discussion'}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
