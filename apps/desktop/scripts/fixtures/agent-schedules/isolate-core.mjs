import { beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Establish isolation before test modules import Core. A fixture's vi.unstubAllEnvs()
// can only restore this private baseline, never the launching user's journal.
const objectCli = process.env.AGENTMUX_TEST_OBJECT_CLI
function selectPrivate(root) {
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/.test(key)) delete process.env[key]
  Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'),
    ...(objectCli ? { AGENTMUX_TEST_OBJECT_CLI: objectCli } : {}) })
}
const baseline = await mkdtemp(join(tmpdir(), 'amux-schedule-baseline-'))
selectPrivate(baseline)
let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amux-schedule-test-'))
  selectPrivate(root)
})
afterEach(async () => {
  selectPrivate(baseline)
  if (root) await rm(root, { recursive: true, force: true })
})
afterAll(async () => { await rm(baseline, { recursive: true, force: true }) })
