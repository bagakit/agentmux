import { connectLocalAgentMux } from '@agentmux/core'

let client = null
try {
  client = await connectLocalAgentMux()
  throw new Error('AgentMux unexpectedly connected without committing its ctxmux owner receipt.')
} catch (error) {
  if (client) throw error
  process.stdout.write(`${JSON.stringify({
    rejected: true,
    message: error instanceof Error ? error.message : String(error)
  })}\n`)
} finally {
  await client?.dispose()
}
