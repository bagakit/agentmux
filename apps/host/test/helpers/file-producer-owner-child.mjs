import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [mode, configuration] = process.argv.slice(2)
const c = JSON.parse(await readFile(configuration, 'utf8'))
for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) delete process.env[key]
process.env.AGENTMUX_STATE_DIRECTORY = c.state
process.env.AGENTMUX_RUNTIME_DIRECTORY = c.runtime
const core = await import(pathToFileURL(c.coreEntry).href)
// This proof consumes the actual semantic startup/lease, not Native Run activation.
// A private finite Files helper is the only physical producer in this process.
core.AgentMuxClient.prototype.connect = async function () {}
let owner
try {
  owner = await core.startHeadlessAgentMux({ store: new core.AgentMuxFileAgentSessionStore(join(c.state, 'sessions.json')), stateDirectory: c.state, socketPath: mode === 'producer' ? c.originalSocket : mode === 'closing' ? join(c.runtime, 'closing.sock') : c.contenderSocket })
  if (mode === 'closing') {
    const scope = owner.client.retainExecutionDirectoryMutation(async () => false)
    const stopping = owner.stop()
    try { scope.spawnFileProducer(() => { throw new Error('A closing owner must not call spawn') }); throw new Error('Closing owner granted borrowing') }
    catch (error) { process.stdout.write(JSON.stringify({ closingBorrowCode: error.code }) + '\n') }
    finally { scope.release(); await stopping }
    process.exit(0)
  }
  if (mode === 'probe') { process.stdout.write(JSON.stringify({ acquired: true, identity: owner.ownerIdentity() }) + '\n'); await owner.stop(); process.exit(0) }
  process.send?.({ type: 'owner', identity: owner.ownerIdentity(), pid: process.pid })
  process.env.FILE_PRODUCER_NATIVE_HELPER = c.nativeHelper
  process.env.FILE_PRODUCER_EVIDENCE = c.evidence
  process.env.FILE_PRODUCER_LEASE_PATH = join(c.state, 'semantic-owner.lock')
  const { runWorkspaceFileWorker } = await import(pathToFileURL(c.workerEntry).href)
  const scope = owner.client.retainExecutionDirectoryMutation(async () => false)
  const outcome = runWorkspaceFileWorker(c.workspace, c.workspace, c.request, {
    helperPath: c.wrapper, workerSource: '', spawnFiniteFileProducer: scope.spawnFileProducer
  }, undefined, undefined, { stage: async () => {} })
  await outcome.finally(() => scope.release())
  await owner.stop()
} catch (error) {
  process.stdout.write(JSON.stringify({ acquired: false, code: error.code, message: error.message }) + '\n')
  if (owner) await owner.stop()
  process.exit(mode === 'probe' && error.code === 'RUNTIME_OWNER_BUSY' ? 0 : 1)
}
