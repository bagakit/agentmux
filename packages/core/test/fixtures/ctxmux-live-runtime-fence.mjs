import { createInterface } from 'node:readline'
import { connectLocalAgentMux } from '@agentmux/core'

const client = await connectLocalAgentMux()
const commands = createInterface({ input: process.stdin, crlfDelay: Infinity })

try {
  process.stdout.write(`${JSON.stringify({
    phase: 'ready',
    identity: client.runtimeIdentity()
  })}\n`)

  for await (const command of commands) {
    if (command !== 'dispatch') throw new Error(`Unexpected live Runtime fence command: ${command}`)
    try {
      const run = await client.createTerminal({
        workspacePath: process.cwd(),
        createOperationId: 'packed-live-runtime-fence'
      })
      process.stdout.write(`${JSON.stringify({ phase: 'dispatch', ok: true, runId: run.runId })}\n`)
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        phase: 'dispatch',
        ok: false,
        name: error instanceof Error ? error.name : typeof error,
        code: error && typeof error === 'object' && 'code' in error ? error.code : null,
        message: error instanceof Error ? error.message : String(error)
      })}\n`)
    }
    break
  }
} finally {
  commands.close()
  await client.dispose()
}
