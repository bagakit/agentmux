import type { AppConfig, ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE, scratchTopicDirectoryName, scratchTopicIdFromDirectoryName, scratchTopicStorageRoots } from '../../../shared/scratch-topics'

/** Latest filesystem read; never persisted or copied into Tab/Session identity. */
export type ScratchTopicsSnapshot = {
  scope: string
  revision: number
  topics: readonly ScratchTopicSnapshot[] | null
  error: string | null
  discoveryError?: string | null
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
    ...(topics?.filter(topic => topic.id !== PMO_TEAMS_TOPIC_ID && (topic.kind === 'mote' || topic.kind === undefined && (topic.soul !== undefined || topic.moteArchive !== undefined))) ?? [])]
}

export function scratchTopicKind(topicId: string, topics: readonly ScratchTopicSnapshot[] | null | undefined): 'mote' | 'topic' | 'unknown' {
  if (topicId === PMO_TEAMS_TOPIC_ID) return 'mote'
  const topic = topics?.find(topic => topic.id === topicId)
  if (!topic) return 'unknown'
  if (topic.kind === 'mote' || topic.kind === undefined && (topic.soul !== undefined || topic.moteArchive !== undefined)) return 'mote'
  return topic.readError ? 'unknown' : 'topic'
}

/** Consume the current original Scratch observation, including its exact address facts. */
export function scratchTopicsForConfig(config: AppConfig | null | undefined, snapshots: Readonly<Record<string, ScratchTopicsSnapshot>> | undefined): readonly ScratchTopicSnapshot[] | null {
  return snapshots ? scratchTopicsForWorkspace(snapshots, config?.workspaces.find(workspace => workspace.id === '__scratch__')) : null
}

/** Classify an original file mutation, without reading or maintaining another catalog. */
export function scratchTopicInvalidation(workspace: Pick<WorkspaceRecord, 'id' | 'path'>,
  topics: readonly ScratchTopicSnapshot[] | null | undefined, path: string, structural = false): string | 'catalog' | null {
  if (workspace.id !== '__scratch__') return null
  const clean = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').replace(/^\.\//, '')
  const changed = clean(path), roots = Object.values(scratchTopicStorageRoots(workspace.path)).map(clean)
  if (!changed || changed === '.' || roots.includes(changed)) return structural ? 'catalog' : null
  const candidates = (topics ?? []).flatMap(topic => [...new Set([
    topic.directoryPath, scratchTopicDirectoryName(topic.id), topic.physicalDirectoryPath,
    topic.identityDirectoryPath, ...(topic.confirmedDirectoryPaths ?? [])
  ].filter((value): value is string => Boolean(value)))].map(directory => ({ id: topic.id, directory: clean(directory) })))
  const matches = candidates.filter(item => changed === item.directory || changed.startsWith(item.directory + '/'))
  const ids = [...new Set(matches.map(item => item.id))]
  if (ids.length > 1) return 'catalog'
  if (ids.length === 1) {
    const entry = matches.sort((a, b) => b.directory.length - a.directory.length)[0]!
    const suffix = changed.slice(entry.directory.length).replace(/^\//, '')
    if (!suffix || suffix === '.agentmux/directory-identity.json' || suffix.startsWith('.agentmux/directory-identity.')) return 'catalog'
    return suffix === 'topic.md' || suffix === 'SOUL.md' || suffix === 'MOTE.md' || suffix === '.agents' || suffix.startsWith('.agents/') ||
      ['.agentmux/topic-wiki.md', '.agentmux/topic-wiki.json', '.agentmux/mote-state.json'].includes(suffix) ? entry.id : null
  }
  const relative = roots.find(root => changed.startsWith(root + '/'))
  const segments = (relative ? changed.slice(relative.length + 1) : changed).split('/')
  const id = scratchTopicIdFromDirectoryName(segments[0] ?? '')
  if (id) return 'catalog' // An unobserved resource, not a new guessed Mote.
  return structural && segments.length === 1 && /^[0-9a-f]{16}$/.test(segments[0] ?? '') ? 'catalog' : null
}
