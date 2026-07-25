export const SCRATCH_WORKSPACE_ID = '__scratch__'
export const SCRATCH_WORKSPACE_NAME = 'Scratch'
export const SCRATCH_TOPIC_TITLE_MAX_LENGTH = 120

const SCRATCH_TOPIC_ID = /^(launcher|session|view):([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/
const SCRATCH_TOPIC_DIRECTORY = /^topic--(launcher|session|view)--([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/

export type ScratchTopicCollaborator = {
  fileName: string
  providerId: string
  sessionId: string
}

export type ScratchTopicSnapshot = {
  id: string
  directoryPath: string
  topicPath: string
  title: string
  summary: string
  collaborators: ScratchTopicCollaborator[]
}

export function isScratchTopicId(topicId: string): boolean {
  return SCRATCH_TOPIC_ID.test(topicId)
}

export function scratchTopicDirectoryName(topicId: string): string {
  const match = SCRATCH_TOPIC_ID.exec(topicId)
  if (!match) throw new Error('Invalid Scratch Topic identity')
  return `topic--${match[1]}--${match[2]}`
}

export function scratchTopicIdFromDirectoryName(name: string): string | null {
  const match = SCRATCH_TOPIC_DIRECTORY.exec(name)
  return match ? `${match[1]}:${match[2]}` : null
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '') || path
}

export function scratchTopicIdFromWorkspacePath(
  scratchRoot: string,
  workspacePath: string
): string | null {
  const root = trimTrailingSeparators(scratchRoot)
  if (!workspacePath.startsWith(`${root}/`) && !workspacePath.startsWith(`${root}\\`)) return null
  const relative = workspacePath.slice(root.length + 1)
  if (!relative || relative.includes('/') || relative.includes('\\')) return null
  return scratchTopicIdFromDirectoryName(relative)
}

export function workspaceOwnsSessionPath(
  workspace: { id: string; hostId: string; path: string },
  session: { hostId: string; workspacePath: string }
): boolean {
  if (workspace.hostId !== session.hostId) return false
  if (workspace.path === session.workspacePath) return true
  return workspace.id === SCRATCH_WORKSPACE_ID &&
    scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath) !== null
}
