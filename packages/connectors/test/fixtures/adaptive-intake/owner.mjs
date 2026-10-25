import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startHeadlessAgentMux, AgentMuxError } from '../../../../core/src/index.js'

const owner = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock'),
  externalInputAuthority: { async assertCurrent(author, intent) {
    if (author.kind !== 'external' || author.connectionId !== 'adaptive-fixture' || author.actor.application.domain !== 'fixture.example' ||
      intent.agentSessionId !== 'adaptive-session' || !['unknown-message', 'waiting-message'].includes(intent.messageId)) throw new AgentMuxError('Not this isolated fixture grant.', 'INGRESS_ACTOR_NOT_AUTHORIZED')
  } }
})
const kernel = Reflect.get(owner.client, 'kernel'), write = kernel.input.bind(kernel)
kernel.input = async (run, input) => {
  const result = await write(run, input)
  if (existsSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'input-failure'))) throw new Error('Private fixture loses receipt after actual PTY write')
  return result
}
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
