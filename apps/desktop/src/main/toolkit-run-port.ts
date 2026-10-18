import type { AgentMuxClientEvent, AgentMuxRun, AgentMuxRunAttachment, AgentMuxRunRef, AgentMuxTerminalCreateInput, AgentMuxPreparedTerminal } from '@agentmux/core'
export interface ToolkitRunPort {
  prepare(input: AgentMuxTerminalCreateInput): Promise<AgentMuxPreparedTerminal>
  createPrepared(input: AgentMuxPreparedTerminal): Promise<AgentMuxRun>
  create(input: AgentMuxTerminalCreateInput, onEvent: (event: AgentMuxClientEvent) => void, output?: 'raw' | 'terminal'): Promise<AgentMuxRun>
  /** Lifecycle only: leaves the shared terminal attachment and byte stream with their original owner. */
  observe(ref: AgentMuxRunRef, onEvent: (event: AgentMuxClientEvent) => void): () => void
  attach(ref: AgentMuxRunRef, afterByte: number, onEvent?: (event: AgentMuxClientEvent) => void): Promise<AgentMuxRunAttachment>
  replay(ref: AgentMuxRunRef, afterByte: number): Promise<AgentMuxRunAttachment>
  status(ref: AgentMuxRunRef): Promise<AgentMuxRun | null>
  release(ref: AgentMuxRunRef): Promise<void>
  stop(ref: AgentMuxRunRef): Promise<void>
  remove(ref: AgentMuxRunRef): Promise<void>
}
