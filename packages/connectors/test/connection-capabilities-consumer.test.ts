import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../core/dist/index.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

it('the original default Host exposes adapter room implementations through public SDK and compiled connection discovery without testing native permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-channel-support-'))
  const services = await createDesktopConnections({ directory: root, encryption: enrollmentEncryption() })
  const socketPath = join(root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, connections: services.connections })
  await server.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  try {
    for (const [adapterId, domain] of [['feishu', 'open.feishu.cn'], ['discord', 'discord.com'], ['unknown-native', 'unknown.example']]) {
      await sdk.call('connection.configure', { operationId: 'configure-' + adapterId, expectedRevision: null,
        connection: { connectionId: adapterId!, adapterId: adapterId!, application: { domain: domain!, appId: '100' }, label: adapterId!, enabled: false, credentialRef: 'unresolved-credential' } })
    }
    const records = (await sdk.call('connection.ls', {})).connections
    const feishu = records.find(record => record.config.adapterId === 'feishu')!, discord = records.find(record => record.config.adapterId === 'discord')!
    expect(feishu.capabilities).toEqual({ roomDiscovery: true, roomCreation: true, roomLink: true })
    expect(discord.capabilities).toEqual({ roomDiscovery: true, roomCreation: false, roomLink: true })
    expect(records.find(record => record.config.adapterId === 'unknown-native')).not.toHaveProperty('capabilities')
    expect(discord.observation.authentication.state).toBe('disabled')
    expect((await sdk.call('connection.inspect', { connectionId: discord.config.connectionId })).connection).toEqual(discord)
    const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'ls'], objectCliEnvironment(root))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result.connections).toEqual(records)
    const help = await runCompiledObjectCli(['connection', 'ls', '--help'], objectCliEnvironment(root))
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('do not confirm native permissions')
    expect(services.database!.prepare('SELECT count(*) AS count FROM connection_configuration').get()!.count).toBe(3)
  } finally { await sdk.dispose(); await server.stop(); services.close(); await rm(root, { recursive: true, force: true }) }
})
