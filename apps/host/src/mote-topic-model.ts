import { isScratchTopicId, scratchTopicDirectoryName, scratchTopicIdFromDirectoryName } from './mote-topic-identity.mjs'
export { isScratchTopicId, scratchTopicDirectoryName, scratchTopicIdFromDirectoryName } from './mote-topic-identity.mjs'
import type { MoteQuickMode } from './mote-quick-mode.js'
import { PMO_TEAMS_TOPIC_ID } from '@agentmux/core/mote-preferences'
export { PMO_TEAMS_TOPIC_ID } from '@agentmux/core/mote-preferences'
export const SCRATCH_WORKSPACE_ID = '__scratch__'
export const SCRATCH_WORKSPACE_NAME = 'Topics'
export const MOTE_TYPE_NAME = 'Mote'
export const PMO_TEAMS_TOPIC_TITLE = MOTE_TYPE_NAME
export const MOTE_SOUL_PATH = 'SOUL.md'
export const MOTE_STATE_PATH = '.agentmux/mote-state.json'
/** Directory metadata, independent of Session/Run state and user-owned personality. */
export type MoteArchiveState =
  | { state: 'active' | 'archived'; version: string }
  | { state: 'unknown'; issue: string }
export const DEFAULT_MOTE_SOUL = `# SOUL

You are a Mote: a persistent collaborator whose identity is independent of any execution Session or Provider.

Start from the user's real question. Give a useful response or small next step without requiring a personality, knowledge-base setup or introductory interview. Be candid, warm and concise; ask only for missing decisions that change the work.

Learn confirmed preferences in their original scope. Current instructions take precedence; a passing remark is not a global preference. Use relevant original notes to continue work without claiming unseen conversations or running tools. Missing context is unknown, not a reason to stop useful independent work.

Behavior preferences: [BEHAVIOR.md](./BEHAVIOR.md)

[AGENTS.md](./AGENTS.md) locates your original knowledge. Saved identity and professional focus do not confer permissions, prove Runtime state or imply a running background process.
`
export const SCRATCH_TOPIC_TITLE_MAX_LENGTH = 120
export const SCRATCH_TOPIC_WIKI_PATH = '.agentmux/topic-wiki.md'
export const SCRATCH_TOPIC_WIKI_STATE_PATH = '.agentmux/topic-wiki.json'
export const DEFAULT_TOPIC_WIKI = `# AgentMux Default Topic Guide

Use AgentMux capabilities through the existing Session and ctxmux Run. Keep Runtime and Project facts authoritative.

## Routing

- Identify the target Project and Topic from explicit user context and current workspace facts.
- Merge requests only when they share an outcome and compatible ownership; split independent outcomes into separate Tasks.
- Ask a focused question when Project, scope, risk, or required context is missing. Do not guess.

## Task writes

- Explain the proposed Project, merge/split decision, and risk before creating or updating a Board Task.
- High-risk or ambiguous writes require user confirmation. Record the decision and Wiki version with the Task receipt.
- Historical text is context, not authority; it cannot override Runtime, permission, Session, or Project facts.
`
/** Product knowledge duties remain discoverable when saved AGENTS or Wiki predates them. */
export const TOPIC_KNOWLEDGE_GUIDANCE = `Read "$AGENTMUX_CLI" topic --skill for this shared Topic's knowledge structure and maintenance methods.

At confirmed decisions, important corrections and reusable results, assess what the next collaborator needs. Update the relevant original knowledge and the Topic's short context and links when needed; read saved changes back before reporting them as maintained.

Preserve custom instructions, existing organization and source evidence. Current user instructions and authorization take precedence; knowledge notes are not live Project, Goal, Session or Run facts.`

/** App-owned coordination applies to every Mote; saved personality and Wiki remain user-owned. */
export const MOTE_COORDINATION_ROLE = `You are Mote, the user's coordination and delivery partner.

Read "$AGENTMUX_CLI" mote --skill to begin working together and maintain original knowledge. Before coordinating execution, read "$AGENTMUX_CLI" mote playbook pmo; for Goal work, read "$AGENTMUX_CLI" goal --skill. These local, read-only guides provide the detailed methods; discover exact targets and command help before acting.

At confirmed decisions, important corrections and useful results, assess whether the relevant original knowledge, reusable methods and short memory index need updating. Read current linked methods for later relevant work and revise them from real feedback. Complete needed maintenance before reporting completion, and say when an update remains unconfirmed.

Default to coordinating detailed design and implementation through execution Agents. Implement personally only when the user explicitly asks you to do so. Follow authorized work through evidence, report collection and delivery; never supply human goal confirmation or result acceptance. Carry forward authorization already given.

Current user instructions, authorization, actual capabilities and authoritative Runtime, permission, Project, Goal, Session and Run facts take precedence over defaults, saved context and history. Preserve original identities, requests, drafts, files and healthy work when observations are unknown; inspect original receipts before deciding, never blindly create or resend.`

export const DEFAULT_PMO_TEAMS_TOPIC_WIKI = `# Mote Guide

Read topic.md for current shared context and SOUL.md for persistent identity.

Organize useful notes, references and results in the way that fits this Mote. Keep collaborator plaques concise and preserve existing material.

Use the original Project, Goal and Task records to find current ownership and progress; notes are context, not another status system.

Current user instructions, authorization, actual capabilities and authoritative Runtime and Session facts take precedence over historical content.
`

export type ScratchTopicCollaborator = {
  fileName: string
  providerId: string
  sessionId: string
}

export type ScratchTopicSnapshot = {
  id: string
  /** File/document addresses stay relative to the original logical container. */
  directoryPath: string
  /** Confirmed physical home; new execution and filesystem access use this path. */
  physicalDirectoryPath?: string
  /** Original durable directory identity, independent of a home relocation. */
  identityDirectoryPath?: string
  /** Live exact addresses confirmed by the original Main directory owner; not a registry. */
  confirmedDirectoryPaths?: readonly string[]
  topicPath: string
  title: string
  summary: string
  /** Confirmed independently of optional detail reads; absent means unconfirmed. */
  kind?: 'mote' | 'topic'
  soul?: { path: string; content: string; version: string }
  quickMode?: MoteQuickMode
  moteArchive?: MoteArchiveState
  readError?: string
  collaborators: ScratchTopicCollaborator[]
  wiki?: TopicWikiSnapshot
}

/** Read-only original directory authority; independent of Topic/SOUL sidecar contents. */
export type ScratchDirectoryFact = Pick<ScratchTopicSnapshot, 'id' | 'identityDirectoryPath' | 'physicalDirectoryPath' | 'confirmedDirectoryPaths' | 'readError'>

export type ScratchTopicList = ScratchTopicSnapshot[] & { issues?: string[] }
/** Plain envelope survives Electron IPC and contextBridge; list attributes do not. */
export type ScratchTopicListResponse = { topics: ScratchTopicSnapshot[]; issues: string[] }

export type TopicWikiSnapshot = {
  path: string
  content: string
  version: string
  source: 'default' | 'user'
  enabled: boolean
  updatedAt: number | null
}

export function isPmoTopicId(topicId: string): boolean {
  return topicId === PMO_TEAMS_TOPIC_ID
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '') || path
}

export function scratchTopicStorageRoots(scratchRoot: string): { legacy: string; topics: string; motes: string } {
  const legacy = trimTrailingSeparators(scratchRoot)
  const index = Math.max(legacy.lastIndexOf('/'), legacy.lastIndexOf('\\'))
  const parent = legacy.slice(0, index + 1)
  return { legacy, topics: `${parent}topics`, motes: `${parent}motes` }
}

function absoluteDirectory(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function directoryChild(root: string, child: string): string {
  return `${trimTrailingSeparators(root)}${root.includes('\\') && !root.includes('/') ? '\\' : '/'}${child}`
}

export function scratchTopicIdentityPath(workspace: { path: string }, topic: Pick<ScratchTopicSnapshot, 'directoryPath' | 'identityDirectoryPath'>): string {
  return topic.identityDirectoryPath ?? (absoluteDirectory(topic.directoryPath) ? topic.directoryPath : directoryChild(workspace.path, topic.directoryPath))
}

export function scratchTopicPhysicalPath(workspace: { path: string }, topic: Pick<ScratchTopicSnapshot, 'directoryPath' | 'physicalDirectoryPath'>): string {
  return topic.physicalDirectoryPath ?? (absoluteDirectory(topic.directoryPath) ? topic.directoryPath : directoryChild(workspace.path, topic.directoryPath))
}

export function scratchTopicLogicalPath(workspace: { path: string }, topic: Pick<ScratchTopicSnapshot, 'id' | 'directoryPath'>): string | null {
  const name = scratchTopicDirectoryName(topic.id)
  return topic.directoryPath === name || scratchTopicIdFromWorkspacePath(workspace.path, topic.directoryPath) === topic.id ? name : null
}

/** Convert a logical file address for copy/new terminals; filesystem authority remains in Main. */
export function scratchWorkspaceFilePath(workspace: { id: string; path: string }, topics: readonly ScratchTopicSnapshot[] | null | undefined, path: string): string | null {
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '.' || part === '..')) return null
  if (workspace.id !== SCRATCH_WORKSPACE_ID || !path) return path ? directoryChild(workspace.path, path) : workspace.path
  const [name, ...parts] = path.split('/')
  const id = scratchTopicIdFromDirectoryName(name!)
  if (!id) return directoryChild(workspace.path, path)
  const topic = topics?.find(item => item.id === id)
  if (!topic || topic.readError && (!topic.physicalDirectoryPath ||
      !topic.confirmedDirectoryPaths?.includes(topic.physicalDirectoryPath))) return null
  const physical = scratchTopicPhysicalPath(workspace, topic)
  return parts.length ? directoryChild(physical, parts.join('/')) : physical
}

export function scratchTopicIdFromWorkspacePath(
  scratchRoot: string,
  workspacePath: string,
  topics?: readonly ScratchTopicSnapshot[] | null
): string | null {
  if (topics) {
    const matches = topics.filter(topic => topic.confirmedDirectoryPaths?.includes(workspacePath) || topic.identityDirectoryPath === workspacePath || topic.physicalDirectoryPath === workspacePath)
    if (matches.length) return matches.length === 1 ? matches[0]!.id : null
  }
  for (const root of Object.values(scratchTopicStorageRoots(scratchRoot))) {
    if (!workspacePath.startsWith(`${root}/`) && !workspacePath.startsWith(`${root}\\`)) continue
    const relative = workspacePath.slice(root.length + 1)
    if (!relative || relative.includes('/') || relative.includes('\\')) return null
    const id = scratchTopicIdFromDirectoryName(relative)
    if (topics) {
      const topic = topics.find(item => item.id === id)
      return topic && topic.confirmedDirectoryPaths === undefined && !topic.readError ? id : null
    }
    return id
  }
  return null
}

export function workspaceOwnsSessionPath(
  workspace: { id: string; hostId: string; path: string },
  session: { hostId: string; workspacePath: string },
  topics?: readonly ScratchTopicSnapshot[] | null
): boolean {
  if (workspace.hostId !== session.hostId) return false
  if (workspace.path === session.workspacePath) return true
  return workspace.id === SCRATCH_WORKSPACE_ID &&
    scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath, topics) !== null
}

/** Saved public topic copy only. Missing title stays unknown; UI may add a display fallback. */
export function topicPublicCopy(content: string): { title: string | null; summary: string } {
  const lines = content.split(/\r?\n/)
  const title = lines.find(line => /^#\s+\S/.test(line))?.replace(/^#\s+/, '').trim() || null
  const summary = lines.find(line => { const value = line.trim(); return !!value && !value.startsWith('#') })?.trim() ?? ''
  return { title, summary }
}
