import { AgentMuxError } from './errors.js'
import { expandCliOptionAssignments } from './cli-option-assignments.js'
import { readControlJsonInput } from './cli-json-input.js'
import { parseMeshNetworkParams, type MeshNetworkMethod } from './mesh-network.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'

export const MESH_NETWORK_CLI_COMMANDS: readonly AgentMuxCliCommand[] = ([
  ['settings.mesh.inspect', '[--operation-id ID]', 'Read this original Core’s private Mesh configuration and original save receipt.'],
  ['settings.mesh.configure', '--input FILE|-', 'Compare and durably save this Core’s Mesh configuration; inspect live adoption separately.'],
  ['mesh.inspect', '', 'Read this Core’s actual network producer, listener, authenticated peers, advertisements and paths.'],
  ['mesh.link', '--input FILE|-', 'Choose this Mesh ingress for an original complete offer without changing its publisher or device key.'],
] as const).map(([method, usage, summary]) => ({
  method, usage, summary,
  flags: method === 'settings.mesh.inspect' ? { '--operation-id': 'data' } : method === 'mesh.inspect' ? {} : { '--input': 'data' },
  details: method === 'mesh.link' ? 'JSON input: {offer: ORIGINAL_CONNECTION_OFFER}. The complete returned offer/url keeps the original serverId and daemonPublicKeyB64. Consume it with the existing --endpoint CLI or directly authorized device SDK. A path is no business or owner grant. Read amux mesh --skill.' :
    'Configure JSON: {expectedRevision,operationId,configuration:{role:"disabled"|"participant"|"gateway",networkId,members:[{peerId,publicKey}],peers:[{peerId,endpoints:[{endpoint:"host:port",useTls:boolean}]}],endpointAccess:{allowedClientKeys:[BASE64_RPC_CLIENT_PUBLIC_KEY]},publishers:[{serverId,tokenHash}],advertisedIngress?:[{endpoint,useTls}],listen?:{host,port,tls?:{keyPath,certPath}}}}. Start by copying settings.mesh.inspect.configuration and revision. For a minimal participant, keep peers/publishers/allowedClientKeys/advertisedIngress empty and add this response identity as the sole member; choose role=participant and a networkId. Gateway role borrows explicitly configured HTTP when listen is absent; otherwise configure listen, and set explicit advertisedIngress separately. Core supplies the private network key/epoch. Automatic Host publication uses its original device identity, and endpointAccess pins its independently generated RPC client public keys before authorization. Keep the original operation ID after an unknown save and inspect it; never replay it. Network identity and Core Runtime identity are separate. Active adoption is mesh.inspect, independently from disk acknowledgement. Read amux mesh --skill.',
  parse: async (original: readonly string[]) => {
    const args = expandCliOptionAssignments(original)
    let input: unknown = {}
    if (method === 'settings.mesh.inspect') {
      if (args.length) { if (args.length !== 2 || args[0] !== '--operation-id') throw new AgentMuxError('Use the original Mesh save operation ID once.', 'INVALID_CLI_ARGUMENT'); input = { operationId: args[1] } }
    } else if (method === 'mesh.inspect') {
      if (args.length) throw new AgentMuxError('Mesh inspection accepts no target or replacement endpoint.', 'INVALID_CLI_ARGUMENT')
    } else {
      if (args.length !== 2 || args[0] !== '--input') throw new AgentMuxError('Use exactly --input FILE|- with the original Mesh request.', 'INVALID_CLI_ARGUMENT')
      input = await readControlJsonInput(args[1]!, 'Original Mesh request')
    }
    return parseMeshNetworkParams(method as MeshNetworkMethod, input) as unknown as Record<string, unknown>
  },
}))
