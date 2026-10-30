import { AgentMuxRpcService } from '../../core/src/public-rpc-service.js'
import { createHostGoals } from '../../../apps/host/src/goals.js'
import { join } from 'node:path'

// The original Host domain owner and public service are real. No Agent is
// launched: accidental Agent work must fail, not disappear behind a mock ACK.
export function hostFixture(root) {
  const forbidden = () => { throw Error('Demand lock proof must not operate an Agent') }
  const owner = createHostGoals({ configurationPath: join(root, 'configuration.json'),
    projects: async () => [], coreCall: forbidden,
    runtime: () => ({ client: new Proxy({}, { get: () => forbidden }), ownerIdentity: () => ({ ownerInstanceId: 'demand-lock-proof' }) }) })
  const service = new AgentMuxRpcService({ coreClients: () => [], goalControl: owner.execute })
  return { owner, call: (method, params) => service.call(method, params, { principal: { kind: 'user', id: 'demand-lock-user' } }) }
}
