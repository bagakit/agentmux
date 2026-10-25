import { AgentMuxControlServer, AgentMuxSpatialStateStore } from '@agentmux/core'
import { createHostContent } from '@agentmux/host/content-owner'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
const root = process.argv[2]!
const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
const commit = spatial.commit.bind(spatial)
spatial.commit = async input => {
  if (input.graph.spaces.some(space => space.kind === 'mote')) {
    let fail = false
    try { await access(join(root, 'fail-spatial')); fail = true } catch {}
    if (fail) throw Object.assign(new Error('Injected spatial interruption after original directory exchange.'), { code: 'SPATIAL_STATE_CONFLICT' })
  }
  return commit(input)
}
const content = createHostContent({ configurationPath: join(root, 'config.json'), spatial })
const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), spatialState: spatial, coreClients: () => [], ...content })
await server.start()
process.stdout.write('READY\n')
process.once('SIGTERM', () => { void server.stop().then(() => process.exit(0)) })
