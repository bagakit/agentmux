import { parseFileReadParams, type FileReadParams } from './public-rpc-files.js'

export function parseFileReadCommand(input: { zoneId: string; spaceId?: string; path: string; hostId: string; workspaceId: string; workspacePath: string; maxBytes?: number }): FileReadParams {
  return parseFileReadParams({ zoneId: input.zoneId, ...(input.spaceId ? { spaceId: input.spaceId } : {}), path: input.path,
    expectedResource: { hostId: input.hostId, workspaceId: input.workspaceId, workspacePath: input.workspacePath }, ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }) })
}
