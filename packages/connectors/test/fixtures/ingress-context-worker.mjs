import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { startHeadlessAgentMux, AgentMuxSpatialStateStore } from '../../../core/dist/index.js'
import { createConnectionServices } from '../../dist/index.js'
import { createConnectionExternalInputAuthority } from '../../../../apps/host/src/external-input-authority.ts'

const state = process.env.AGENTMUX_STATE_DIRECTORY
let owner
const observation = { authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'ready' }, delivery: { state: 'unknown', reason: 'not-started' } }
const adapter = { adapterId: 'sample', test: async () => observation,
  ingress: { adapterId: 'sample', verify: async (_config, raw) => {
    const parsed = JSON.parse(raw)
    if (parsed.proof !== 'adapter-private-witness') throw Error('Wrong private transport proof')
    return parsed.event
  }, readHistory: async (config, input, _credential, signal) => {
    const quote = { version: 1, application: config.application, externalConversationId: input.externalConversationId,
      observedAt: Date.now(), range: input.range, coverage: 'partial', gaps: [{ reason: 'private-page-pending' }], records: [{ messageId: 'confirmed-native-prefix', contentType: 'private.native.text',
        content: 'Confirmed original native prefix', author: { kind: 'unknown' }, resources: [] }] }
    input.snapshot?.(() => structuredClone(quote))
    appendFileSync(join(state, 'context-reads.jsonl'), JSON.stringify({ range: input.range, signalAlreadyAborted: signal.aborted }) + '\n')
    // This private leaf deliberately ignores abort. The production owner must release its exact observer.
    return await new Promise(() => {})
  } }, transport: { start: async input => {
    const closed = new AbortController()
    const timer = setInterval(() => {
      const path = join(state, 'transport-event.json')
      if (!existsSync(path)) return
      clearInterval(timer)
      void input.receive({ raw: readFileSync(path, 'utf8') }, () => writeFileSync(path + '.acked', 'ACK'))
    }, 10)
    return { closed: closed.signal, close() { clearInterval(timer); closed.abort() }, observation: () => observation,
      lifecycle: () => ({ state: 'ready' }) }
  } } }
const services = await createConnectionServices({ directory: join(state, 'connections'), adapters: [adapter],
  bindings: { spatial: new AgentMuxSpatialStateStore(join(state, 'spatial.json')),
    session: ref => owner.client.readAgentSession(ref.agentSessionId), checkpoint: ref => owner.client.conversationCheckpoint(ref) },
  ingress: { core: host => host === 'local' ? owner?.client : undefined } })
const credential = await services.secrets.store({ operationId: 'context-private-secret', secret: 'private-credential' })
await services.connections.configure({ operationId: 'context-configure', expectedRevision: null, connection: {
  connectionId: 'sample-connection', adapterId: 'sample', application: { domain: 'chat.example', appId: 'original-app' },
  label: 'Private context witness', enabled: true, credentialRef: credential.credentialRef } })
owner = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'custody.sock'),
  service: { connections: services.connections }, externalInputAuthority: createConnectionExternalInputAuthority({ ingress: async () => services.ingress, executionHostId: 'local' }) })
const compiled = ['../../../core/dist/client.js', '../../../core/dist/ingress-codec.js', '../../../core/dist/channel-quote.js',
  '../../../core/dist/observation-read.js', '../../dist/durable-ingress.js']
writeFileSync(join(state, 'context-loaded-' + process.pid + '.json'), JSON.stringify({ pid: process.pid, owner: owner.ownerIdentity(), entry: import.meta.url,
  execArgv: process.execArgv, artifacts: Object.fromEntries(compiled.map(path => { const url = new URL(path, import.meta.url); return [url.href, createHash('sha256').update(readFileSync(url)).digest('hex')] })) }))
// Feed the declared Pi native protocol at its real Hook owner, on this private original Run.
// It supplies quote correlation only; the actual body effect is independently witnessed by the real PTY.
const create = owner.client.createAgent.bind(owner.client)
owner.client.createAgent = async (...args) => {
  const session = await create(...args), source = 'private-context-native', path = join(state, 'pi-native.jsonl')
  writeFileSync(path, [ { type: 'session', version: 3, id: source, timestamp: new Date().toISOString(), cwd: args[0].workspacePath },
    { type: 'message', id: 'original-before-binding', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'Original native protocol work' }], timestamp: Date.now() } } ].map(JSON.stringify).join('\n') + '\n')
  await owner.client.acceptHookEvent({ receiptId: 'private-native-source', agentSessionId: session.agentSessionId, runId: session.run.runId,
    providerId: 'pi', eventName: 'agent_end', payload: { session_id: source, session_file: path } }, new AbortController().signal)
  return session
}
const database = services.database, commit = database.exec.bind(database)
database.exec = sql => {
  const result = commit(sql)
  if (sql !== 'COMMIT') return result
  const row = database.prepare("SELECT ingress_id,context_json,rejoin_json FROM connection_ingress_message WHERE context_json IS NOT NULL ORDER BY sequence DESC LIMIT 1").get()
  if (!row) return result
  const context = JSON.parse(String(row.context_json)), actions = Object.values(JSON.parse(String(row.rejoin_json))).map(value => value.action)
  const accepted = existsSync(join(state, 'crash-after-context-action')) && actions.some(action => action.outcome === 'pending' && action.source.kind === 'context-observation')
  const frozen = existsSync(join(state, 'crash-after-context-gap')) && context.quote && actions.some(action => action.outcome === 'context-ended')
  if (accepted || frozen) {
    writeFileSync(join(state, accepted ? 'accepted-context-action.json' : 'frozen-context-gap.json'), JSON.stringify({ row, context, actions, owner: owner.ownerIdentity() }))
    process.kill(process.pid, 'SIGKILL')
  }
  return result
}
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void services.close(); void owner.stop() })
