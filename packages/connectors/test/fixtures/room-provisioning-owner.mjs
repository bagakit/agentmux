import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { ConnectionHost, RoomProvisioningHost } from '@agentmux/connectors'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'

const root = process.argv[2], input = JSON.parse(process.argv[3])
process.on('message', () => {})
const connections = new ConnectionHost({ databasePath: join(root, 'connections.sqlite'), secrets: { resolve: async () => 'private-fixture-credential' },
  adapters: [{ adapterId: 'sample', test: async () => { throw new Error('Configuration checking is outside this controlled effect.') }, rooms: {
    create: async request => { await writeFile(join(root, 'room-effect'), request.attemptId); process.send({ kind: 'effect-applied', attemptId: request.attemptId }); return await new Promise(() => {}) },
    addMembers: async () => { throw new Error('Members cannot dispatch after an unknown creation.') }
  } }] })
const rooms = new RoomProvisioningHost({ connections, spatial: new AgentMuxSpatialStateStore(join(root, 'spatial.json')) })
await rooms.create(input, { actor: { kind: 'user', id: 'fixture-user' } })
