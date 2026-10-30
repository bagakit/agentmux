import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHeadlessAgentMux, AgentMuxSpatialStateStore } from '../../../core/dist/index.js'
import { createConnectionServices } from '../../dist/index.js'
import { createConnectionExternalInputAuthority } from '../../../../apps/host/src/external-input-authority.ts'

const state = process.env.AGENTMUX_STATE_DIRECTORY
let owner
const observation = { authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'ready' }, delivery: { state: 'unknown', reason: 'not-started' } }
const adapter = { adapterId: 'sample', test: async () => observation,
  ingress: { adapterId: 'sample', verify: async (_config, raw) => {
    const parsed = JSON.parse(raw)
    if (parsed.proof !== 'adapter-private-witness') throw Error('Wrong original transport proof')
    return parsed.event
  } }, transport: { start: async input => {
    const closed = new AbortController()
    const timer = setInterval(() => {
      const path = join(state, 'transport-event.json')
      if (!existsSync(path)) return
      const raw = readFileSync(path, 'utf8'); writeFileSync(path + '.received', raw)
      // The private source emits just once; the real receiver owns ACK/dispatch.
      clearInterval(timer)
      void input.receive({ raw }, () => writeFileSync(path + '.acked', 'ACK'))
    }, 10)
    return { closed: closed.signal, close() { clearInterval(timer); closed.abort() }, observation: () => observation,
      lifecycle: () => ({ state: 'ready' }) }
  } } }
const services = await createConnectionServices({ directory: join(state, 'connections'), adapters: [adapter],
  bindings: { spatial: new AgentMuxSpatialStateStore(join(state, 'spatial.json')),
    session: ref => owner.client.readAgentSession(ref.agentSessionId),
    // Exact history protocol fixture is supplied before bind, separate from the real PTY input witness.
    checkpoint: async () => JSON.parse(readFileSync(join(state, 'checkpoint.json'), 'utf8')) },
  ingress: { core: host => host === 'local' ? owner?.client : undefined } })
const credential = await services.secrets.store({ operationId: 'custody-private-secret', secret: 'private-credential' })
await services.connections.configure({ operationId: 'custody-configure', expectedRevision: null, connection: {
  connectionId: 'sample-connection', adapterId: 'sample', application: { domain: 'chat.example', appId: 'original-app' },
  label: 'Private custody witness', enabled: true, credentialRef: credential.credentialRef } })
const external = createConnectionExternalInputAuthority({ ingress: async () => services.ingress, executionHostId: 'local' })
owner = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'custody.sock'),
  service: { connections: services.connections }, externalInputAuthority: external })
const queue = Reflect.get(owner.client, 'messageQueue'), gate = queue.authorizeInputDispatch.bind(queue)
queue.authorizeInputDispatch = async (...args) => {
  const link = await gate(...args)
  if (link && existsSync(join(state, 'hold-after-gate'))) {
    writeFileSync(join(state, 'gate-witness.json'), JSON.stringify(link))
    await new Promise(() => {})
  }
  return link
}
const submit = owner.client.submitAgentMessage.bind(owner.client)
owner.client.submitAgentMessage = async (...args) => {
  if (existsSync(join(state, 'hold-before-firstsave'))) {
    writeFileSync(join(state, 'before-firstsave.json'), JSON.stringify(args[0]))
    await new Promise(() => {})
  }
  const receipt = await submit(...args)
  if (existsSync(join(state, 'hold-after-firstsave'))) {
    writeFileSync(join(state, 'after-firstsave.json'), JSON.stringify(receipt))
    await new Promise(() => {})
  }
  return receipt
}
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { services.close(); void owner.stop() })
