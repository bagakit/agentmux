import type { AgentMuxRpcParams } from '../dist/public-rpc.js'
import type { MeshNetworkConfiguration } from '../dist/mesh-network.js'
import type { ConnectionOffer } from '@agentmux/relay/offer'
declare const offer: ConnectionOffer
declare const configuration: MeshNetworkConfiguration
const link: AgentMuxRpcParams<'mesh.link'> = { offer }
const inspectOriginal: AgentMuxRpcParams<'settings.mesh.inspect'> = { operationId: 'original-save' }
const save: AgentMuxRpcParams<'settings.mesh.configure'> = { operationId: 'original-save', expectedRevision: 'original-revision', configuration }
const invalidLink: AgentMuxRpcParams<'mesh.link'> = {
  offer,
  // @ts-expect-error Mesh link has its exact public DTO; no generic control-operation field.
  operationId: 'unadmitted-extra-field'
}
void [link, inspectOriginal, save, invalidLink]
