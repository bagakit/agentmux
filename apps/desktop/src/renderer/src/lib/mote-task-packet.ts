import { parseFocusTaskReference, type AgentMuxFocusTaskReference } from '@agentmux/core/focus-control'

/** Original human task intent and its fixed platform-guidance selector, never a wire envelope. */
export type MoteTaskPacket = string | { prompt: string; focusTask: AgentMuxFocusTaskReference }
export type PreparedMoteTask = { prompt: string; focusTask?: AgentMuxFocusTaskReference }

/** Freeze references when the user prepares a task; retries never read current membership. */
export function prepareMoteTask(value: MoteTaskPacket): PreparedMoteTask {
  if (typeof value === 'string') return { prompt: value }
  return { prompt: value.prompt, focusTask: parseFocusTaskReference(value.focusTask) }
}

export function moteTaskPacketKey(prompt: string, focusTask?: AgentMuxFocusTaskReference): string {
  return JSON.stringify([prompt, focusTask ? parseFocusTaskReference(focusTask) : null])
}
