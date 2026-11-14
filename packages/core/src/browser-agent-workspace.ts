import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'

/** Original Browser resource and environment, independent of its display occurrence. */
export type BrowserAgentWorkspaceSource = {
  browserId: string; workspaceId: string; mode: 'normal' | 'private'; profileId: string | null
}
export type BrowserAgentWorkspaceParams = {
  browserId: string
  expected?: Omit<BrowserAgentWorkspaceSource, 'browserId'>
}
export type BrowserAgentWorkspaceResult = {
  source: BrowserAgentWorkspaceSource
  profileLabel?: string
  scope: 'survey-profile' | 'survey-private' | 'existing'
  outcome: 'ready' | 'unconfirmed'
  directory: { hostId: string; path: string | null; status: 'confirmed' | 'unconfirmed' | 'not-required' }
  registration: 'confirmed' | 'unconfirmed' | 'not-attempted'
  workspace: { id: string; name: string; hostId: string; path: string; kind: 'folder' | 'worktree' } | null
  issue?: { step: 'directory' | 'registration' | 'source'; message: string }
}

function environment(raw: unknown): Omit<BrowserAgentWorkspaceSource, 'browserId'> {
  const row = rpcRecord(raw, ['workspaceId', 'mode', 'profileId'])
  if ((row.mode !== 'normal' && row.mode !== 'private') ||
    row.profileId !== null && typeof row.profileId !== 'string' || row.mode === 'private' && row.profileId !== null) {
    throw new AgentMuxError('The original Browser environment is invalid.', 'INVALID_CONTROL_REQUEST')
  }
  return { workspaceId: rpcString(row.workspaceId, 'Browser Workspace'), mode: row.mode,
    profileId: row.profileId === null ? null : rpcString(row.profileId, 'Browser Profile') }
}
export function parseBrowserAgentWorkspaceParams(raw: unknown): BrowserAgentWorkspaceParams {
  const row = rpcRecord(raw, ['browserId', 'expected'])
  return { browserId: rpcString(row.browserId, 'Browser identity'),
    ...(row.expected === undefined ? {} : { expected: environment(row.expected) }) }
}
export function parseBrowserAgentWorkspaceResult(raw: unknown): BrowserAgentWorkspaceResult {
  const row = rpcRecord(raw, ['source', 'profileLabel', 'scope', 'outcome', 'directory', 'registration', 'workspace', 'issue'], 'CONTROL_PROTOCOL_ERROR')
  const source = rpcRecord(row.source, ['browserId', 'workspaceId', 'mode', 'profileId'], 'CONTROL_PROTOCOL_ERROR')
  const { browserId, ...rest } = source
  const directory = rpcRecord(row.directory, ['hostId', 'path', 'status'], 'CONTROL_PROTOCOL_ERROR')
  if (!['survey-profile', 'survey-private', 'existing'].includes(String(row.scope)) ||
    !['ready', 'unconfirmed'].includes(String(row.outcome)) ||
    !['confirmed', 'unconfirmed', 'not-required'].includes(String(directory.status)) ||
    !['confirmed', 'unconfirmed', 'not-attempted'].includes(String(row.registration))) {
    throw new AgentMuxError('Browser execution directory receipt is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  let workspace: BrowserAgentWorkspaceResult['workspace'] = null
  if (row.workspace !== null) {
    const item = rpcRecord(row.workspace, ['id', 'name', 'hostId', 'path', 'kind'], 'CONTROL_PROTOCOL_ERROR')
    if (item.kind !== 'folder' && item.kind !== 'worktree') throw new AgentMuxError('Execution resource kind is invalid.', 'CONTROL_PROTOCOL_ERROR')
    workspace = { id: rpcString(item.id, 'Workspace'), name: rpcString(item.name, 'Workspace name'),
      hostId: rpcString(item.hostId, 'Execution Host'), path: rpcString(item.path, 'Execution path'), kind: item.kind }
  }
  let issue: BrowserAgentWorkspaceResult['issue']
  if (row.issue !== undefined) {
    const item = rpcRecord(row.issue, ['step', 'message'], 'CONTROL_PROTOCOL_ERROR')
    if (item.step !== 'directory' && item.step !== 'registration' && item.step !== 'source') throw new AgentMuxError('Directory preparation step is invalid.', 'CONTROL_PROTOCOL_ERROR')
    issue = { step: item.step, message: rpcString(item.message, 'Preparation issue') }
  }
  if (row.outcome === 'ready' && (!workspace || row.registration !== 'confirmed' || directory.status === 'unconfirmed' ||
    workspace.hostId !== directory.hostId || workspace.path !== directory.path || issue)) {
    throw new AgentMuxError('Execution readiness has not been confirmed.', 'CONTROL_PROTOCOL_ERROR')
  }
  return { source: { browserId: rpcString(browserId, 'Browser identity'), ...environment(rest) },
    ...(row.profileLabel === undefined ? {} : { profileLabel: rpcString(row.profileLabel, 'Profile name') }),
    scope: row.scope as BrowserAgentWorkspaceResult['scope'], outcome: row.outcome as BrowserAgentWorkspaceResult['outcome'],
    directory: { hostId: rpcString(directory.hostId, 'Execution Host'), path: directory.path === null ? null : rpcString(directory.path, 'Execution path'), status: directory.status as BrowserAgentWorkspaceResult['directory']['status'] },
    registration: row.registration as BrowserAgentWorkspaceResult['registration'], workspace, ...(issue ? { issue } : {}) }
}
