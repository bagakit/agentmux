import { connectLocalAgentMux } from '@agentmux/core'

const client = await connectLocalAgentMux()
try {
  process.stdout.write(`${JSON.stringify(client.runtimeIdentity())}\n`)
} finally {
  await client.dispose()
}
