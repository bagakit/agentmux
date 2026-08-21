import { connectLocalAgentMux, AgentMuxFileAgentSessionStore } from '@agentmux/core'

const [mode, workspacePath, storePath, retainedRunId] = process.argv.slice(2)
const client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(storePath) })
try {
  const runId = mode === 'create'
    ? (await client.createTerminal({
        workspacePath,
        command: process.execPath,
        args: ['-e', 'process.stdout.write("retained-terminal-ready\\n"); process.stdin.resume()'],
        cols: 80,
        rows: 24
      })).runId
    : retainedRunId
  if (mode === 'create') await client.resizeTerminal({ runId }, 132, 45)
  if (mode === 'resize') await client.resizeTerminal({ runId }, 160, 50)
  const attached = await client.attachTerminal(runId, 0)
  process.stdout.write(`${JSON.stringify({
    clientPid: process.pid,
    daemonInstance: client.runtimeIdentity().instanceId,
    run: attached.run
  })}\n`)
} finally {
  await client.dispose()
}
