import assert from 'node:assert/strict'
import { connectLocalAgentMux } from '@agentmux/core'

const client = await connectLocalAgentMux()
try {
  assert.equal(client.runtimeIdentity().ownership, 'unverified')
  await client.listRuns()
  process.stdout.write(`${JSON.stringify(client.runtimeIdentity())}\n`)
} finally {
  await client.dispose()
}
