import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSnapshot } from '../../../shared/contracts'
import { scratchTopicIdentityPath, scratchTopicLogicalPath, scratchTopicPhysicalPath } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import { scratchTopicKind, scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { topicSpaceIconTarget, type SpaceIconChoice } from './space-object-appearance'

export type MoteConversationIdentity = {
  workspaceId: string; topicId: string; objectKey: string; name: string; icon: SpaceIconChoice | null
}
export type MoteConversationOwner = MoteConversationIdentity & {
  hostId: string; identityDirectoryPath: string; physicalDirectoryPath: string
}

/** Original Tab/Topic facts work even when the retained View paints in another portal. */
export function useMoteConversationOwner(workspaceId: string, tabId: string | undefined, visible: boolean): MoteConversationOwner | null {
  const facts = useAppStore(useShallow(state => ({
    topicId: visible && tabId ? state.tabs[tabId]?.topicId : undefined,
    tabWorkspaceId: visible && tabId ? state.tabs[tabId]?.workspaceId : undefined,
    config: visible ? state.config : null,
    snapshot: visible ? state.scratchTopicSnapshots[workspaceId] : undefined
  })))
  const owner = useMemo(() => {
    const workspace = facts.config?.workspaces.find(item => item.id === workspaceId)
    const topics = workspace && facts.snapshot ? scratchTopicsForWorkspace({ [workspaceId]: facts.snapshot }, workspace) : null
    const topic = topics?.find(item => item.id === facts.topicId)
    if (facts.tabWorkspaceId !== workspaceId || !workspace || !topic || !topics || scratchTopicKind(topic.id, topics) !== 'mote' ||
      scratchTopicLogicalPath(workspace, topic) === null) return null
    const identityDirectoryPath = scratchTopicIdentityPath(workspace, topic), physicalDirectoryPath = scratchTopicPhysicalPath(workspace, topic)
    const target = topicSpaceIconTarget(workspace, topic)
    return { workspaceId, topicId: topic.id, objectKey: target.key, name: topic.title,
      hostId: workspace.hostId, identityDirectoryPath, physicalDirectoryPath }
  }, [facts, workspaceId])
  const icon = useAppStore(state => owner ? state.spaceObjectIcons[owner.objectKey] ?? null : null)
  return useMemo(() => owner ? { ...owner, icon } : null, [owner, icon])
}

/** Display identity never changes the recorded Session author or its details. */
export function moteConversationIdentity(owner: MoteConversationOwner | null, session: SessionSnapshot | undefined): MoteConversationIdentity | undefined {
  if (!owner || session?.kind !== 'agent' || session.hostId !== owner.hostId ||
    (session.workspacePath !== owner.identityDirectoryPath && session.workspacePath !== owner.physicalDirectoryPath)) return undefined
  return owner
}
