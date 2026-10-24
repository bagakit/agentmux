import { readOriginalMoteConfiguration } from './mote-resources.js'
import { workspaceOwnsSessionPath } from './mote-topic-model.js'
import type { FileWorkspace } from './file-resource-model.js'
export type PresentationWorkspace = FileWorkspace & { name: string; branch?: string }
export type PresentationConfiguration = {
  workspaces: PresentationWorkspace[]
  executors: Record<string, { providerId: string; label: string; avatar?: { tint?: string; badge?: string } }>
  appearance: { spaceObjectIcons?: Record<string, unknown>; agentAvatars?: Record<string, { tint?: string; badge?: string }> }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** One fresh read of original metadata; this object never owns configuration or launch policy. */
export async function readPresentationConfiguration(path: string): Promise<PresentationConfiguration> {
  const raw = await readOriginalMoteConfiguration(path)
  if (!record(raw) || !Array.isArray(raw.workspaces) || !record(raw.executors)) throw new Error('The original presentation configuration is unconfirmed. Original spaces and Agents remain available; restore its readable metadata.')
  const workspaces: PresentationWorkspace[] = []
  for (const value of raw.workspaces) {
    if (!record(value) || !['id', 'hostId', 'path', 'name'].every(key => typeof value[key] === 'string')) throw new Error('An original Workspace presentation record is unreadable. Its spatial identity is retained.')
    workspaces.push({ id: value.id as string, hostId: value.hostId as string, path: value.path as string, name: value.name as string,
      ...(record(value.closeout) && typeof value.closeout.targetWorkspaceId === 'string' ? { closeout: { targetWorkspaceId: value.closeout.targetWorkspaceId } } : {}),
      ...(typeof value.kind === 'string' ? { kind: value.kind } : {}), ...(typeof value.repoPath === 'string' ? { repoPath: value.repoPath } : {}), ...(typeof value.branch === 'string' ? { branch: value.branch } : {}) })
  }
  const executors: PresentationConfiguration['executors'] = {}
  for (const [id, value] of Object.entries(raw.executors)) if (record(value) && typeof value.providerId === 'string' && typeof value.label === 'string') {
    executors[id] = { providerId: value.providerId, label: value.label, ...(avatar(value.avatar) ? { avatar: avatar(value.avatar)! } : {}) }
  }
  const appearance = record(raw.appearance) ? raw.appearance : {}
  return { workspaces, executors, appearance: {
    ...(record(appearance.spaceObjectIcons) ? { spaceObjectIcons: appearance.spaceObjectIcons } : {}),
    ...(record(appearance.agentAvatars) ? { agentAvatars: Object.fromEntries(Object.entries(appearance.agentAvatars).flatMap(([key, value]) => avatar(value) ? [[key, avatar(value)!]] : [])) } : {}) } }
}
function avatar(value: unknown): { tint?: string; badge?: string } | undefined {
  if (!record(value)) return undefined
  return { ...(typeof value.tint === 'string' ? { tint: value.tint } : {}), ...(typeof value.badge === 'string' ? { badge: value.badge } : {}) }
}
export function workspacePresentationLabel(config: Pick<PresentationConfiguration, 'workspaces'>, hostId: string, path: string): string {
  return config.workspaces.find(workspace => workspaceOwnsSessionPath(workspace, { hostId, workspacePath: path }))?.name
    ?? path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path
}
/** The single Provider/Workspace fallback shared by Desktop and the independent Host. */
export function configuredAgentFallbackLabel(config: Pick<PresentationConfiguration, 'executors' | 'workspaces'>,
  session: { executorId: string; providerId: string; hostId: string; workspacePath: string }): string {
  const executor = Object.hasOwn(config.executors, session.executorId) ? config.executors[session.executorId] : undefined
  const label = executor?.providerId === session.providerId ? executor.label : session.executorId
  return `${label} · ${workspacePresentationLabel(config, session.hostId, session.workspacePath)}`
}
