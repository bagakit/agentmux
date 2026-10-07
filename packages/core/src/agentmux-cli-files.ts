import { parseFileReadParams, type FileReadParams } from './public-rpc-files.js'
import { createReadStream } from 'node:fs'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from './public-rpc-frame.js'

/** The proposed body owns stdin; the exact observed base comes from one named local file. */
export async function readFileWriteBase(path: string): Promise<string> {
  if (!path || path === '-') throw new AgentMuxError('--base requires a named UTF-8 file; the proposed content uses stdin.', 'INVALID_CLI_ARGUMENT')
  const stream = createReadStream(path), chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('The base content cannot fit the original RPC frame budget.', 'INVALID_CLI_ARGUMENT')
      chunks.push(buffer)
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
  } catch (error) {
    if (error instanceof AgentMuxError) throw error
    throw new AgentMuxError('--base must name a readable UTF-8 file; its bytes and line endings are not rewritten.', 'INVALID_CLI_ARGUMENT')
  } finally { stream.destroy() }
}

export function parseFileReadCommand(input: { zoneId: string; spaceId?: string; path: string; hostId: string; workspaceId: string; workspacePath: string; maxBytes?: number }): FileReadParams {
  return parseFileReadParams({ zoneId: input.zoneId, ...(input.spaceId ? { spaceId: input.spaceId } : {}), path: input.path,
    expectedResource: { hostId: input.hostId, workspaceId: input.workspaceId, workspacePath: input.workspacePath }, ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }) })
}
