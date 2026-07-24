import {
  connectSshAgentMux
} from '@agentmux/core'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const hostId = required('AGENTMUX_REMOTE_HOST_ID')
const buildIdentity = required('AGENTMUX_REMOTE_BUILD_ID')
const client = await connectSshAgentMux({
  target: {
    hostId,
    hostname: required('AGENTMUX_REMOTE_HOST'),
    ...(process.env.AGENTMUX_REMOTE_USER ? { user: process.env.AGENTMUX_REMOTE_USER } : {})
  },
  runtime: {
    buildIdentity,
    remoteNodePath: process.env.AGENTMUX_REMOTE_NODE_PATH ?? 'node',
    remoteEntrypointPath: required('AGENTMUX_REMOTE_ENTRYPOINT_PATH'),
    remoteEndpointPath: required('AGENTMUX_REMOTE_ENDPOINT_PATH')
  }
})
const terminal = await client.createTerminal({
  runId: crypto.randomUUID(),
  createOperationId: crypto.randomUUID(),
  workspacePath: required('AGENTMUX_REMOTE_CWD')
})
await client.stopTerminal(terminal)
await client.dispose()
process.stdout.write(`${JSON.stringify({ hostId, buildIdentity }, null, 2)}\n`)
