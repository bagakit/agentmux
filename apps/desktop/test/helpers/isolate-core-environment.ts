import { join } from 'node:path'
import { vi } from 'vitest'

/** A controlled Core must never borrow the runner's live Runtime or durable paths. */
export function isolateCoreFixtureEnvironment(directory: string) {
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries({
    AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'),
    AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(directory, 'agent-sessions.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson')
  })) vi.stubEnv(key, value)
}
