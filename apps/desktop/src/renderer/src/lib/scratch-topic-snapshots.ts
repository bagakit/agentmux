import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE, scratchTopicDirectoryName } from '../../../shared/scratch-topics'

/** Latest filesystem read; never persisted or copied into Tab/Session identity. */
export type ScratchTopicsSnapshot = {
  scope: string
  revision: number
  topics: readonly ScratchTopicSnapshot[] | null
  error: string | null
  reading: boolean
}

export function scratchTopicsScope(workspace: Pick<WorkspaceRecord, 'hostId' | 'path'>): string {
  return JSON.stringify([workspace.hostId, workspace.path])
}

export function scratchTopicsForWorkspace(
  snapshots: Readonly<Record<string, ScratchTopicsSnapshot>>,
  workspace: WorkspaceRecord | null | undefined
): readonly ScratchTopicSnapshot[] | null {
  if (!workspace) return null
  const snapshot = snapshots[workspace.id]
  return snapshot?.scope === scratchTopicsScope(workspace) ? snapshot.topics : null
}

const DEFAULT_MOTE: ScratchTopicSnapshot = {
  id: PMO_TEAMS_TOPIC_ID, title: PMO_TEAMS_TOPIC_TITLE, summary: '',
  directoryPath: scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID),
  topicPath: `${scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)}/topic.md`, collaborators: []
}

/** The same directory objects are used by Space and the footer chooser. */
export function scratchMoteTopics(topics: readonly ScratchTopicSnapshot[] | null | undefined): readonly ScratchTopicSnapshot[] {
  return [topics?.find(topic => topic.id === PMO_TEAMS_TOPIC_ID) ?? DEFAULT_MOTE,
    ...(topics?.filter(topic => topic.id !== PMO_TEAMS_TOPIC_ID && topic.soul) ?? [])]
}

export function scratchTopicKind(topicId: string, topics: readonly ScratchTopicSnapshot[] | null | undefined): 'mote' | 'topic' | 'unknown' {
  if (topicId === PMO_TEAMS_TOPIC_ID) return 'mote'
  const topic = topics?.find(topic => topic.id === topicId)
  if (!topic || topic.readError) return 'unknown'
  return topic.soul ? 'mote' : 'topic'
}
