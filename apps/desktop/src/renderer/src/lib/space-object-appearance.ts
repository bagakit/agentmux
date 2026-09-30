import { isMoteAvatarRef, isMoteFace, type MoteAvatarRef, type MoteAvatarTarget, type MoteFace } from '../../../shared/mote-avatars'
import {
  Bot, BookOpen, Bookmark, Brain, Code, Compass, Database, FileText, FlaskConical,
  Folder, Gem, Layers, Library, Lightbulb, NotebookText, Package, Puzzle,
  Rocket, Shapes, SquareTerminal, Wrench
} from 'lucide-react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID } from '../../../shared/scratch-topics'
import { joinWorkspacePath } from './workspace-paths'
import type { WorkspaceProject } from './workspace-projects'
import { directoryIdentity } from '../../../shared/space-addresses'

/** One bounded, named source for the picker, renderer and persisted-value validation. */
export const SPACE_ICON_CATALOG = {
  bot: { label: 'Agent', Icon: Bot },
  book: { label: 'Book', Icon: BookOpen },
  bookmark: { label: 'Bookmark', Icon: Bookmark },
  brain: { label: 'Brain', Icon: Brain },
  code: { label: 'Code', Icon: Code },
  compass: { label: 'Compass', Icon: Compass },
  database: { label: 'Database', Icon: Database },
  document: { label: 'Document', Icon: FileText },
  flask: { label: 'Research', Icon: FlaskConical },
  folder: { label: 'Folder', Icon: Folder },
  gem: { label: 'Gem', Icon: Gem },
  layers: { label: 'Layers', Icon: Layers },
  library: { label: 'Library', Icon: Library },
  lightbulb: { label: 'Idea', Icon: Lightbulb },
  notebook: { label: 'Notebook', Icon: NotebookText },
  package: { label: 'Package', Icon: Package },
  puzzle: { label: 'Puzzle', Icon: Puzzle },
  rocket: { label: 'Rocket', Icon: Rocket },
  shapes: { label: 'Shapes', Icon: Shapes },
  terminal: { label: 'Terminal', Icon: SquareTerminal },
  wrench: { label: 'Tools', Icon: Wrench }
} as const

export type SpaceIconId = keyof typeof SPACE_ICON_CATALOG
export type SpaceIconChoice = SpaceIconId | MoteAvatarRef | MoteFace
export type SpaceIconOverrides = Record<string, SpaceIconChoice>
export type SpaceIconTarget = { key: string; name: string; kind: 'folder' | 'topic' | 'mote'; avatarTarget?: MoteAvatarTarget }

export function isSpaceIconId(candidate: unknown): candidate is SpaceIconId {
  return typeof candidate === 'string' && Object.hasOwn(SPACE_ICON_CATALOG, candidate)
}

function absoluteDirectory(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Host and durable directory, never a display name, classification, Session or worktree id. */
export function spaceObjectIdentityKey(hostId: string, directoryPath: string): string {
  return directoryIdentity(hostId, directoryPath)
}

function isSpaceObjectIdentityKey(key: string): boolean {
  try {
    const parts: unknown = JSON.parse(key)
    return Array.isArray(parts) && parts.length === 2
      && typeof parts[0] === 'string' && parts[0] !== ''
      && typeof parts[1] === 'string' && absoluteDirectory(parts[1])
      && spaceObjectIdentityKey(parts[0], parts[1]) === key
  } catch { return false }
}

export function folderSpaceIconTarget(project: Pick<WorkspaceProject, 'hostId' | 'repoPath' | 'name'>): SpaceIconTarget {
  return { key: spaceObjectIdentityKey(project.hostId, project.repoPath), name: project.name, kind: 'folder' }
}

export function topicSpaceIconTarget(
  workspace: Pick<WorkspaceRecord, 'hostId' | 'path'> & { id?: string },
  topic: Pick<ScratchTopicSnapshot, 'id' | 'directoryPath' | 'title' | 'soul'>
): SpaceIconTarget {
  const key = spaceObjectIdentityKey(workspace.hostId, absoluteDirectory(topic.directoryPath) ? topic.directoryPath : joinWorkspacePath(workspace.path, topic.directoryPath))
  return {
    key,
    name: topic.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : topic.title,
    kind: topic.id === PMO_TEAMS_TOPIC_ID || topic.soul ? 'mote' : 'topic',
    ...(workspace.id && (topic.id === PMO_TEAMS_TOPIC_ID || topic.soul) ? { avatarTarget: { workspaceId: workspace.id, topicId: topic.id, objectKey: key } } : {})
  }
}

/** A damaged record cannot erase other authored identities or the retained work surface. */
export function restoreSpaceIconOverrides(candidate: unknown): SpaceIconOverrides {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  return Object.fromEntries(Object.entries(candidate).filter(([key, value]) =>
    isSpaceObjectIdentityKey(key) && (isSpaceIconId(value) || isMoteAvatarRef(value) || isMoteFace(value)))) as SpaceIconOverrides
}

export function requireSpaceIconSelection(key: string, icon: unknown): asserts icon is SpaceIconChoice | null {
  if (!isSpaceObjectIdentityKey(key) || (icon !== null && !isSpaceIconId(icon) && !isMoteAvatarRef(icon) && !isMoteFace(icon))) {
    throw new Error('Choose a valid Space object and icon.')
  }
}
