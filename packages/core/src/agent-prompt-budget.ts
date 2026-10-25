/** Soft budget for selecting optional launch context, measured on the complete wire.
 * Required platform content and the original request are preserved even when they exceed it.
 * Input admission belongs to the actual carrier and durable record contracts. */
export const AGENT_LAUNCH_CONTEXT_BUDGET_BYTES = 64 * 1024

/** Finite terminal observation window; it does not limit admissible input bytes. */
export const AGENT_COMPOSER_SCAN_BACK_ROWS = 64 * 1024

/** Retain the rows available to the bounded composer observation. */
export const AGENT_SCREEN_SCROLLBACK_ROWS = AGENT_COMPOSER_SCAN_BACK_ROWS

const ENCODER = new TextEncoder()

/** Whether adding optional context would exceed the launch selection budget. */
export function agentLaunchContextExceedsBudget(prompt: string): boolean {
  return ENCODER.encode(prompt).length > AGENT_LAUNCH_CONTEXT_BUDGET_BYTES
}
