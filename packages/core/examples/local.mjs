import {
  connectLocalAgentMux, mintObjectId
} from '@agentmux/core'

const client = await connectLocalAgentMux()
const output = new Promise((resolve) => {
  const unsubscribe = client.onEvent((event) => {
    if (event.type !== 'terminal-output' || !event.data.includes('agentmux-local-ready')) return
    unsubscribe()
    resolve()
  })
})
const terminal = await client.createTerminal({
  createOperationId: mintObjectId(),
  workspacePath: process.cwd()
})
await client.writeTerminal(terminal, {
  ownerInstanceId: client.runtimeIdentity().instanceId,
  operationId: mintObjectId(),
  expectedByte: terminal.acceptedInputBytes,
  data: "printf 'agentmux-local-ready\\n'\n"
})
await output
await client.stopTerminal(terminal)
await client.dispose()
