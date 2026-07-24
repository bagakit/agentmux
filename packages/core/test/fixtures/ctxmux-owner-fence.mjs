import assert from 'node:assert/strict'
import { connectLocalAgentMux } from '@agentmux/core'

await assert.rejects(
  connectLocalAgentMux(),
  (error) => error?.code === 'CTXMUX_OWNER_IDENTITY_UNPROVEN'
)

process.stdout.write('ctxmux-owner-fence-ok\n')
