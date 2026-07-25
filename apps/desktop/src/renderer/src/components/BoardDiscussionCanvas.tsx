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
import { configuredExecutors } from '../lib/executors'
import type { ProjectBranchLane } from '../lib/project-board'
import { executorDetectionKey, useAppStore } from '../store'
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
  const detections = useAppStore((state) => state.executorDetections)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const activateWorkspaceSelection = useAppStore((state) => state.activateWorkspaceSelection)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const launchBoardAgent = useAppStore((state) => state.launchBoardAgent)
  const [executorId, setExecutorId] = useState('codex')
  const [prompt, setPrompt] = useState('')
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hostId = lane?.workspace?.hostId ?? anchor.hostId
  const executors = useMemo(
    () => configuredExecutors(config).map((executor) => ({
      ...executor,
      detection: detections[executorDetectionKey(hostId, executor.id)]
    })),
    [config?.executors, detections, hostId]
  )
  const installedExecutors = executors.filter((executor) => executor.detection?.state === 'ready')
  const unavailableExecutors = executors.filter((executor) => executor.detection?.state !== 'ready')
  const detecting = executors.some((executor) => executor.detection?.state === 'checking')
  const canLaunch = Boolean(
    lane?.branch.worktreePath &&
    prompt.trim() &&
    installedExecutors.some((executor) => executor.id === executorId)
  )

  useEffect(() => {
    if (!lane) return
    setPrompt('')
    setError(null)
  }, [lane])

  useEffect(() => {
    if (!lane || executors.every((executor) => executor.detection)) return
    void detectExecutors(hostId)
  }, [executors, detectExecutors, hostId, lane])

  useEffect(() => {
    if (installedExecutors.some((executor) => executor.id === executorId)) return
    const first = installedExecutors[0]
    if (first) setExecutorId(first.id)
  }, [executorId, installedExecutors])

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
      await launchBoardAgent(workspace.id, executorId, prompt.trim())
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
                      <div><span>Agent</span><small>Detected on {hostId === 'local' ? 'this Mac' : hostId}</small></div>
                      <button type="button" className="icon-button" title="Refresh Agents" disabled={detecting} onClick={() => void detectExecutors(hostId)}>
                        {detecting ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                      </button>
                    </header>
                    <div className="discussion-provider-grid">
                      {installedExecutors.map((executor) => (
                        <button
                          type="button"
                          key={executor.id}
                          className={executor.id === executorId ? 'selected' : ''}
                          aria-pressed={executor.id === executorId}
                          onClick={() => setExecutorId(executor.id)}
                        >
                          <span><AgentProviderIcon providerId={executor.providerId} size={22} /></span>
                          <strong>{executor.label}</strong>
                          <small>{agentProviderLabel(executor.providerId)} · Ready</small>
                        </button>
                      ))}
                    </div>
                    {unavailableExecutors.length > 0 ? (
                      <p className="discussion-provider-unavailable">
                        Not available: {unavailableExecutors.map((executor) => executor.label).join(', ')}
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
