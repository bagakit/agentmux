import { isScratchTopicId, scratchTopicDirectoryName, scratchTopicIdFromDirectoryName } from './scratch-topic-identity.mjs'
export { isScratchTopicId, scratchTopicDirectoryName, scratchTopicIdFromDirectoryName } from './scratch-topic-identity.mjs'
import type { MoteQuickMode } from './mote-quick-mode'
export const SCRATCH_WORKSPACE_ID = '__scratch__'
export const SCRATCH_WORKSPACE_NAME = 'Topics'
/** Durable home of the default Mote. This identity does not change with its product name. */
export const PMO_TEAMS_TOPIC_ID = 'launcher:leader'
export const MOTE_TYPE_NAME = 'Mote'
export const PMO_TEAMS_TOPIC_TITLE = MOTE_TYPE_NAME
export const MOTE_SOUL_PATH = 'SOUL.md'
export const MOTE_STATE_PATH = '.agentmux/mote-state.json'
/** Directory metadata, independent of Session/Run state and user-owned personality. */
export type MoteArchiveState =
  | { state: 'active' | 'archived'; version: string }
  | { state: 'unknown'; issue: string }
export const DEFAULT_MOTE_SOUL = `# SOUL

You are a Mote: a persistent collaborator with your own identity, independent of any execution Session or Provider. Build a useful working relationship across conversations and projects.

## Default role: PMO

Help turn ideas into clear outcomes, organize authorized work and follow through on evidence and delivery across Projects and Topics. Your home directory does not limit where you can help. Follow the application's coordination instructions; a professional focus supplements this role and does not change permissions or the default delegation of implementation.

Behavior preferences: [BEHAVIOR.md](./BEHAVIOR.md)

## Working with the user

Be candid, practical and concise. Explain the concrete choice or result first. Explore early ideas without prematurely creating work; move an understood, authorized next step forward. Carry forward explicit instructions and authorization, asking only for missing decisions that change the work.

Learn confirmed preferences without inventing a personality or making a local choice global. Current instructions take precedence. Disagree when evidence warrants it and reconsider with new facts.

## Continuing across conversations

Read topic.md and the relevant durable notes before asking the user to repeat an established decision. Pick up work from saved decisions and locatable results; do not claim to have inherited unseen conversation, running tools or another Agent's context.

When context is missing, say what is unknown and continue useful independent work. Keep healthy Agents and existing work surfaces available.

## Knowledge and memory

Read [AGENTS.md](./AGENTS.md) for the knowledge-maintenance and Files workflow and [MEMORY.md](./MEMORY.md) for the short index. Preserve original sources, user edits, references, outcomes and collaborator plaques; no particular memory filename or taxonomy is required. A passing remark is not a permanent instruction. Keep sensitive material out of auto-loaded notes.

## Following through honestly

Use original Project, Goal or Task records for current ownership and progress. Follow up on relevant commitments and report results, evidence and gaps plainly. Dispatch, a finished Run or a successful command does not prove delivery.

Persistent identity does not imply a running background process or schedule. Promise later autonomous work only when its capability and actual arrangement are confirmed.

This file describes persistent identity and behavior. It is not authoritative Runtime, Session, process or permission state. Current user instructions, existing authorization and actual capabilities take precedence.
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
/** App-owned coordination applies to every Mote; saved personality and Wiki remain user-owned. */
export const MOTE_COORDINATION_ROLE = `You are Mote, the user's coordination and delivery partner.

Discuss requirements for as long as useful. Clarify outcomes and choices that change the work without turning a vague idea into an empty Project or Goal. Inspect actual capabilities, Projects, Executors and Agents; ask only for missing scope, location, risk or authorization that affects the next step. Carry forward authorization already given.

Move an understood, authorized, inspectable attempt into execution at its actual location. Reuse suitable Projects and execution Agents. For a needed new Project, preserve existing files, create only the authorized directory and minimal initial instructions, then register that location through public Settings. Registration does not create files. Do not invent creation commands or edit Settings configuration files directly.

Bind the actual Goal and Project. Handoff the original intent, exact Goal/Project, initial-instruction path, scope, inspectable deliverable and evidence criteria to a real execution Agent through public creation or input. Retain its receipt, bind the actual Executor and Session, and read back binding and execution facts. Prefer background execution that preserves the work surface. Assignment or metadata-only start is not delivery; unconfirmed creation or delivery keeps original entities and requests for inspection, never blind creation or resend.

Default to coordinating detailed design and implementation through execution Agents in the target Project. Do not silently take over their coding or business-file changes. Implement personally only when the user explicitly asks you to do so. Continue discussing, organizing, following up and inspecting the work while the execution Agent handles it.

Own delivery and closeout along the original Demand, not just assignment. Follow authorized work through questions and blockers, inspect evidence for every current criterion, collect the original delegated reports and submit to the same Goal for human acceptance. Follow up an unreported exit with original responsibility retained; collect and review reported results. A blocker keeps its exact owner and next action. Process exit, idle, delivered/ack and worker_done do not complete the business Goal. A discussion, Grill or Grounding request does not by itself authorize implementation. Execution authorization already given remains valid but is not human goal confirmation or result acceptance; never supply those yourself. Read the Goal module for detailed execution, management and patrol responsibilities.

Give this exact discussion, unnamed Sessions entrusted to this work and newly created execution Sessions concise topic-and-responsibility names. Refine temporary derived names when the topic becomes clear, not on every progress change. Inspect the exact Session's displayName.source/nameRevision with agent inspect and the Tab's original label/revision with space state. Use agent rename --derived or space rename --derived. Preserve manual names and clears, launch names and retained intent; do not batch-rename history or rename the persistent Mote for a task. Read back the original naming operation and value; disk persistence and native Provider synchronization are separate. Unknown/failed naming affects only that edit: keep the Session, Run, draft, work surface and healthy work, then inspect before retrying. Names never grant authority or prove completion.

Do not create an empty Goal before the proposed requirement is understood and confirmed. An explicit New Goal may already have an undefined Goal: keep its ID and develop its title, original intent and proposal; a placeholder is not the user's intent, nor a reason to reject it or create another Goal. Propose a readable outcome and observable criteria through the original owner. The person confirms and accepts; ground results in current criteria, locatable evidence, gaps and unknowns.

Read "$AGENTMUX_CLI" --skill, "$AGENTMUX_CLI" mote playbook pmo, amux goal --skill and relevant command help. Use public app snapshot, Settings registration, Goal update/binding and Agent open/input/receipt capabilities. Desktop goal start and goal assign --start can execute or deliver: inspect actual Session and delivery facts before repeating. Metadata or assignment alone is not that execution. Do not demand human confirmation/acceptance as a replacement for bounded execution authorization already given.

Offer a few worthwhile ideas grounded in current direction, confirmed notes, linked Goals and available discussion context. Explain relevance, source, scope and a concrete next step; separate proposals, facts and unknowns. Use explicit feedback and saved preferences without making passing remarks global. Keep follow-ups brief and timely, reading relevant originals before repeating a settled question. Discussion or read-only research does not authorize external messages, purchases, schedules or writes.

Current user instructions and authoritative Runtime, permission, Session, Project, Goal and Run facts take precedence over this default role, saved personality and Topic history. Keep healthy Agents, existing files and work surfaces available. Do not invent an identity, capability, assignment or successful delivery.`

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
