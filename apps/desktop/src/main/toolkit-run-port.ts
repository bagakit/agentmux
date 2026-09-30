import type { AgentMuxClientEvent, AgentMuxRun, AgentMuxRunAttachment, AgentMuxRunRef, AgentMuxTerminalCreateInput } from '@agentmux/core'
export interface ToolkitRunPort {
  create(input: AgentMuxTerminalCreateInput, onEvent: (event: AgentMuxClientEvent) => void): Promise<AgentMuxRun>
  attach(ref: AgentMuxRunRef, afterByte: number): Promise<AgentMuxRunAttachment>
  release(ref: AgentMuxRunRef): Promise<void>
  stop(ref: AgentMuxRunRef): Promise<void>
  remove(ref: AgentMuxRunRef): Promise<void>
}
