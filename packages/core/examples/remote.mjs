import {
  AgentMuxSshRemoteDaemon
} from '@agentmux/core'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const hostId = required('AGENTMUX_REMOTE_HOST_ID')
const buildIdentity = required('AGENTMUX_REMOTE_BUILD_ID')
const manager = new AgentMuxSshRemoteDaemon({
  target: {
    hostId,
    hostname: required('AGENTMUX_REMOTE_HOST'),
    ...(process.env.AGENTMUX_REMOTE_USER ? { user: process.env.AGENTMUX_REMOTE_USER } : {})
  }
})
const installation = await manager.install({
  archivePath: required('AGENTMUX_REMOTE_ARTIFACT'),
  buildIdentity,
  platform: required('AGENTMUX_REMOTE_PLATFORM')
})
await manager.activate(installation)
const client = manager.createClient(installation)
await client.connect()
const terminal = await client.createTerminal({
  sessionId: crypto.randomUUID(),
  createOperationId: crypto.randomUUID(),
  cwd: required('AGENTMUX_REMOTE_CWD')
})
await client.stopTerminal(terminal)
await client.dispose()
process.stdout.write(`${JSON.stringify(installation, null, 2)}\n`)
