import type { RuntimeEvent } from '../../src/shared/contracts'

/** Decode original IPC bytes in order so a split character counts exactly once. */
export function publishedTerminalText(events: readonly RuntimeEvent[], hostId: string, runId: string): string {
  return Buffer.concat(events.flatMap(({ hostId: source, event }) =>
    source === hostId && event.type === 'terminal-output' && event.run.runId === runId ? [event.dataBytes] : []
  )).toString('utf8')
}
