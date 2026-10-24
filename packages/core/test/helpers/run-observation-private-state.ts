import { afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Setup executes before product modules load. Even implicit owner defaults and
// in-memory Session fixtures must not inherit a real Runtime or input journal.
const root = mkdtempSync(join(tmpdir(), 'agentmux-observation-private-'))
const receiptPath = process.env.AGENTMUX_FOCUS_STOP_PRIVATE_RECEIPT
const inputReceiptPath = process.env.AGENTMUX_INPUT_AUTHORITY_CONSUMER_RECEIPT
for (const key of Object.keys(process.env)) {
  if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
}
vi.stubEnv('HOME', root)
vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(root, 'sessions.json'))
vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
if (receiptPath) vi.stubEnv('AGENTMUX_FOCUS_STOP_PRIVATE_RECEIPT', receiptPath)
if (inputReceiptPath) vi.stubEnv('AGENTMUX_INPUT_AUTHORITY_CONSUMER_RECEIPT', inputReceiptPath)

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
