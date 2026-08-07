import * as Dialog from '@radix-ui/react-dialog'
import {
  Bot,
  GitBranch,
  LoaderCircle,
  MessageSquarePlus,
  NotebookText,
  Play,
  RadioTower,
  RefreshCw,
  Unlink,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { describeDeliveryEvidence } from '../lib/delivery-evidence'
import { api } from '../lib/api'
import { configuredExecutors } from '../lib/executors'
import type { BoardRow } from '../lib/project-board'
import { executorDetectionKey, useAppStore } from '../store'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { ComposerTextarea } from './ComposerTextarea'

export function BoardDiscussionCanvas({
  row,
  anchor,
  onClose,
  onOpenBranches
}: {
  row: BoardRow | null
  anchor: WorkspaceRecord
  onClose: () => void
  onOpenBranches: (row: BoardRow) => void
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

  const hostId = row?.workspace?.hostId ?? anchor.hostId
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
  // 能不能起，判据是"这一行有没有落地目录"，对 Branch 与 Topic 同义：Branch 要有 worktree，
  // Topic 恒有目录因此恒可起——不为两种行来源各写一份可用性判定。
  const canLaunch = Boolean(
    row?.path &&
    prompt.trim() &&
    installedExecutors.some((executor) => executor.id === executorId)
  )

  useEffect(() => {
    if (!row) return
    setPrompt('')
    setError(null)
  }, [row])

  useEffect(() => {
    if (!row || executors.every((executor) => executor.detection)) return
    void detectExecutors(hostId)
  }, [executors, detectExecutors, hostId, row])

  useEffect(() => {
    if (installedExecutors.some((executor) => executor.id === executorId)) return
    const first = installedExecutors[0]
    if (first) setExecutorId(first.id)
  }, [executorId, installedExecutors])

  async function startDiscussion(): Promise<void> {
    if (!row || !canLaunch || launching) return
    setLaunching(true)
    setError(null)
    try {
      if (row.kind === 'topic') {
        // Topic 上下文随启动传下去：落点是该 Topic 目录，scratchTopicId 由既有绑定路径携带。
        await launchBoardAgent(anchor.id, executorId, prompt.trim(), row.id)
        onClose()
        return
      }
      let workspace = row.workspace
      if (!workspace) {
        const result = await api.workspaces.openBranch(anchor.id, row.branch.name)
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

  const isTopic = row?.kind === 'topic'
  const ContextIcon = isTopic ? NotebookText : GitBranch

  return (
    <Dialog.Root open={row !== null} onOpenChange={(open) => !open && !launching && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="discussion-canvas__overlay" />
        <Dialog.Content
          className="discussion-canvas"
          onEscapeKeyDown={(event) => launching && event.preventDefault()}
        >
          <header className="discussion-canvas__header">
            <span className="discussion-canvas__mark"><MessageSquarePlus size={18} /></span>
            <div>
              <div className="eyebrow">{isTopic ? 'Topic inbox' : 'Branch inbox'}</div>
              <Dialog.Title>Discuss {row?.name ?? (isTopic ? 'this Topic' : 'this Branch')}</Dialog.Title>
              <Dialog.Description>
                {isTopic
                  ? 'Start a real Agent run in this Topic directory. The run returns to this row.'
                  : 'Start a real Agent run in this Branch workspace. The run returns to this row.'}
              </Dialog.Description>
            </div>
            <button type="button" className="icon-button" aria-label="Close discussion canvas" disabled={launching} onClick={onClose}>
              <X size={15} />
            </button>
          </header>

          {row ? (
            <div className="discussion-canvas__body">
              <section className="discussion-context">
                <span><ContextIcon size={14} /></span>
                <div>
                  <strong>{row.name}</strong>
                  <small title={row.path ?? undefined}>{row.path ?? 'No worktree'}</small>
                </div>
                <em>{hostId === 'local' ? 'This Mac' : <><RadioTower size={11} /> {hostId}</>}</em>
              </section>

              {!row.path ? (
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
                      onOpenBranches(row)
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
                    <ComposerTextarea
                      autoFocus
                      rows={7}
                      value={prompt}
                      onValueChange={setPrompt}
                      placeholder={isTopic
                        ? 'What should the Agent investigate, decide, or write down in this Topic?'
                        : 'What should the Agent investigate, decide, or change on this Branch?'}
                    />
                    <small>The initial prompt is sent through the existing core-owned Agent session.</small>
                  </label>
                </>
              )}
              {error ? <div className="discussion-canvas__error" role="alert">{error}</div> : null}
            </div>
          ) : null}

          <footer className="discussion-canvas__footer">
            {/* 只声明证据支持的那一句。启动投递最多证明送到了——写成"已回复"会让人以为
                对方看过并回应了，而此刻连读都未必读到。 */}
            <span>
              <Bot size={12} /> Core-owned launch · first message will read{' '}
              <strong>{describeDeliveryEvidence('delivered').label}</strong> until the Agent replies
            </span>
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
