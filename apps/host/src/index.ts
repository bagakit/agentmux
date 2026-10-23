import { isAbsolute } from 'node:path'
import { hydrateProcessEnvironmentFromLoginShell, loginShellEnvironmentWarning } from '@agentmux/core'
import { startAgentMuxHost, agentMuxHostStore } from './host.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configuredHostClients } from './configured-host-clients.js'

const storePath = process.env.AGENTMUX_AGENT_SESSION_STORE
if (!storePath || !isAbsolute(storePath)) throw new Error('The Host requires the original absolute Agent Session Store path.')
const storeArgument = process.argv.indexOf('--store')
if (storeArgument !== -1 && process.argv[storeArgument + 1] !== storePath) throw new Error('The Host Store argument and original namespace do not agree.')
const connectionDirectory = process.env.AGENTMUX_CONNECTOR_DIRECTORY
const moteConfigurationPath = process.env.AGENTMUX_MOTE_CONFIGURATION_PATH
const configurationPath = process.env.AGENTMUX_HOST_CONFIGURATION_PATH
const mobileBuildDirectory = process.env.AGENTMUX_MOBILE_BUILD_DIRECTORY ?? join(dirname(fileURLToPath(import.meta.url)), '../../mobile/dist')
// The long-lived execution owner must load the user's shell environment itself;
// a Desktop launched from Finder may still be hydrating when it starts this Host.
const environment = await hydrateProcessEnvironmentFromLoginShell()
const environmentWarning = loginShellEnvironmentWarning(environment)
if (environmentWarning) process.stderr.write(`${environmentWarning}\n`)
const configured = configuredHostClients(configurationPath)
const host = await startAgentMuxHost({ store: agentMuxHostStore(storePath), mobileBuildDirectory,
  ...(configurationPath === undefined ? {} : { configurationPath }),
  ...(connectionDirectory === undefined && moteConfigurationPath === undefined ? {} : { connections: { directory: connectionDirectory, clients: () => configured.clients(),
    ...(moteConfigurationPath === undefined ? {} : { moteConfigurationPath }) } }) }).catch(async error => {
      try { await configured.close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Host startup and configured consumer cleanup failed.') }
      throw error
    })
// Remote readers belong to the opted-in connector owner, after local service is available.
if (connectionDirectory !== undefined || moteConfigurationPath !== undefined) configured.start()
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (stopping) return; stopping = true
  void (async () => {
    const errors: unknown[] = []
    for (const close of [() => host.dispose(), () => configured.close()]) try { await close() } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Host and configured consumer cleanup failed.')
  })().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
})
// RPC owns the process lifetime. Parent/consumer exits have no relationship to a Run lifetime.
const { owner } = await host.hosted.call('runtime.owner.identity', {})
process.stdout.write(JSON.stringify({ protocol: 'jsonrpc-2.0', pid: process.pid, owner,
  mobileAccess: host.mobileAccessState() }) + '\n')
