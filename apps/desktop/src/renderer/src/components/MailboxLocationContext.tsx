import { useMemo, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { groupIds, regionIds } from '@agentmux/layout'
import { useAppStore } from '../store'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { sessionPresentationById } from '../lib/session-presentation'
import { projectWorkspaces } from '../lib/workspace-projects'
import { tabDisplayName, firstPromptFromTimeline } from '../lib/workbench-tabs'
import { agentProviderLabel } from './AgentProviderIcon'

/** A detail-only metadata consumer; it neither owns navigation nor changes its availability. */
export function MailboxLocationContext({ origin, sessionId, pending = false, children }: {
  origin?: OpenHttpLinkOrigin | undefined
  sessionId?: string | undefined
  pending?: boolean
  children(summary: ReactNode, details: ReactNode): ReactNode
}) {
  const { config, tab, layout, executionHost, executionCwd, tabName } = useAppStore(useShallow(state => {
    const tab = origin?.tabId ? state.tabs[origin.tabId] : undefined
    const session = sessionId ? sessionPresentationById(state.sessions).get(sessionId) : undefined
    return { config: state.config, tab, layout: origin ? state.layouts[origin.workspaceId] : undefined,
      executionHost: session?.hostId === session?.control.hostId ? session?.hostId : undefined,
      executionCwd: session?.workspacePath,
      tabName: tab ? tabDisplayName({ tab, fallback: tab.id, agentFactsFor(id) {
        const item = sessionPresentationById(state.sessions).get(id)
        return item?.kind === 'agent' ? { userName: state.agentNames[id], firstPrompt: firstPromptFromTimeline(state.timelines[id]),
          fallbackLabel: item.label, providerLabel: agentProviderLabel(item.providerId) } : null
      } }) : undefined }
  }))
  const [summary, details] = useMemo(() => {
    const group = layout?.groups.find(item => item.id === origin?.tabGroupId)
    const region = origin?.regionId ? tab?.regions[origin.regionId] : undefined
    const confirmed = Boolean(origin && tab && group && layout && origin.tabId && origin.regionId &&
      groupIds(layout.root).includes(group.id) && group.tabOrder.includes(origin.tabId) &&
      regionIds(tab.layout.root).includes(origin.regionId) &&
      (!origin.sessionId || origin.sessionId === sessionId) &&
      (region?.kind === 'agent' || region?.kind === 'terminal') && region.sessionId === sessionId)
    const registered = config?.workspaces.filter(item => item.id === tab?.workspaceId) ?? []
    const workspace = confirmed && registered.length === 1 ? registered[0] : undefined
    const project = workspace && !isScratchWorkspaceId(workspace.id)
      ? projectWorkspaces(config!.workspaces).find(item => item.workspaces.some(one => one.id === workspace.id)) : undefined
    const displayWorkspaces = config?.workspaces.filter(item => item.id === origin?.workspaceId) ?? []
    const displayWorkspace = confirmed && displayWorkspaces.length === 1 ? displayWorkspaces[0] : undefined
    const unknown = '未确认'
    const projectName = project?.name ?? workspace?.name ?? '资源项目未确认'
    const summary = pending ? null : <p className="composer-mailbox__location-summary" data-mailbox-location="summary">
      <span>当前对话位置</span>{confirmed ? <>
        <span className="composer-mailbox__location-name" title={projectName}>{projectName}</span><span> · </span>
        <span className="composer-mailbox__location-name" title={tabName}>{tabName}</span>
      </> : <span className="composer-mailbox__location-name">显示引用未确认</span>}
      {confirmed ? <span className="composer-mailbox__location-region" title={`Region ${origin!.regionId}`}>Region {origin!.regionId!.slice(-8)}</span> : null}
    </p>
    const details = <>
      {!pending ? <section className="composer-mailbox__location-facts" data-mailbox-location="target">
        <h4>{confirmed ? '当前显示位置' : '未确认的显示引用'}</h4>
        {!confirmed ? <p>显示引用未确认；原文和既有定位能力保留。</p> : null}
        <dl className="composer-mailbox__record-facts">
          <dt>显示 Workspace</dt><dd>{displayWorkspace?.name ?? unknown}</dd>
          <dt>显示 Workspace ID</dt><dd>{origin?.workspaceId ?? unknown}</dd>
          <dt>Group ID</dt><dd>{origin?.tabGroupId ?? unknown}</dd>
          <dt>Tab</dt><dd>{confirmed ? tabName : unknown}</dd>
          <dt>Tab ID</dt><dd>{origin?.tabId ?? unknown}</dd>
          <dt>Region ID</dt><dd>{origin?.regionId ?? unknown}</dd>
        </dl>
        <h4>当前资源项目与工作区</h4>
        <dl className="composer-mailbox__record-facts">
          <dt>资源项目</dt><dd>{project?.name ?? unknown}</dd>
          <dt>Project ID</dt><dd>{project?.id ?? unknown}</dd>
          <dt>资源 Host</dt><dd>{workspace?.hostId ?? unknown}</dd>
          <dt>项目根目录</dt><dd>{project?.repoPath ?? unknown}</dd>
          <dt>资源 Workspace ID</dt><dd>{workspace?.id ?? unknown}</dd>
          <dt>资源 Workspace</dt><dd>{workspace?.name ?? unknown}</dd>
          <dt>Workspace / worktree 目录</dt><dd>{workspace?.path ?? unknown}</dd>
          <dt>分支</dt><dd>{workspace ? workspace.branch ?? '未记录' : unknown}</dd>
        </dl>
      </section> : null}
      <section className="composer-mailbox__location-facts" data-mailbox-location="execution">
        <h4>所属 Session 当前执行资料</h4>
        <dl className="composer-mailbox__record-facts">
          <dt>Session ID</dt><dd>{sessionId ?? unknown}</dd>
          <dt>执行 Host</dt><dd>{executionHost ?? unknown}</dd>
          <dt>当前执行 cwd</dt><dd>{executionCwd ?? unknown}</dd>
        </dl>
        <p>当前资料；消息发生时的 Region、项目与 cwd 未记录。</p>
      </section>
    </>
    return [summary, details]
  }, [config, tab, layout, executionHost, executionCwd, tabName, sessionId, pending,
    origin?.workspaceId, origin?.tabGroupId, origin?.tabId, origin?.regionId, origin?.sessionId])
  return children(summary, details)
}
