import { AgentMuxError } from './errors.js'
import { expandCliOptionAssignments } from './cli-option-assignments.js'
import { readControlJsonInput } from './cli-json-input.js'
import { parseMeshNetworkParams, type MeshNetworkMethod } from './mesh-network.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'

export const MESH_NETWORK_CLI_COMMANDS: readonly AgentMuxCliCommand[] = ([
  ['settings.mesh.inspect', '[--operation-id ID] [--input FILE|-]', 'Read this original Core’s private Mesh configuration and original save receipt.'],
  ['settings.mesh.configure', '--input FILE|-', 'Compare and durably save this Core’s Mesh configuration; inspect live adoption separately.'],
  ['mesh.inspect', '[--input FILE|-]', 'Read this Core’s actual network producer, listener, authenticated peers, advertisements and paths.'],
  ['mesh.link', '--input FILE|-', 'Choose this Mesh ingress for an original complete offer without changing its publisher or device key.'],
] as const).map(([method, usage, summary]) => ({
  method, usage: '[--host ID --expected-runtime ID] ' + usage, summary,
  flags: { '--host': 'value', '--expected-runtime': 'value', '--input': 'data', ...(method === 'settings.mesh.inspect' ? { '--operation-id': 'data' as const } : {}) },
  details: 'All JSON inputs accept optional target:{hostId,expectedRuntimeId}. Select a saved operator Host with paired --host/--expected-runtime or JSON target, never both. The entry validates its original caller; the selected Core independently authorizes its saved operator carrier. Device/delegated access grants no remote operator permission. ' + (method === 'mesh.link' ? 'JSON input: {offer: ORIGINAL_CONNECTION_OFFER}. The complete returned offer/url keeps the original serverId and daemonPublicKeyB64. Consume it with the existing --endpoint CLI or directly authorized device SDK. A path is no business or owner grant. Read amux mesh --skill.' :
    'Configure JSON: {expectedRevision,operationId,configuration:{role:"disabled"|"participant"|"gateway",networkId,members:[{peerId,publicKey}],peers:[{peerId,endpoints:[{endpoint:"host:port",useTls:boolean}]}],endpointAccess:{allowedClientKeys:[BASE64_RPC_CLIENT_PUBLIC_KEY]},publishers:[{serverId,tokenHash}],advertisedIngress?:[{endpoint,useTls}],listen?:{host,port,tls?:{keyPath,certPath}}}}. Start by copying settings.mesh.inspect.configuration and revision. For a minimal participant, keep peers/publishers/allowedClientKeys/advertisedIngress empty and add this response identity as the sole member; choose role=participant and a networkId. Gateway role borrows explicitly configured HTTP when listen is absent; otherwise configure listen, and set explicit advertisedIngress separately. Core supplies the private network key/epoch. Automatic Host publication uses its original device identity, and endpointAccess pins its independently generated RPC client public keys before authorization. Keep the original operation ID after an unknown save and inspect it; never replay it. Network identity and Core Runtime identity are separate. Active adoption is mesh.inspect, independently from disk acknowledgement. Read amux mesh --skill.'),
  parse: async (original: readonly string[]) => {
    const args = expandCliOptionAssignments(original)
    const flags = new Map<string, string>()
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]!, value = args[i + 1]
      if (!['--host', '--expected-runtime', '--input', ...(method === 'settings.mesh.inspect' ? ['--operation-id'] : [])].includes(flag) || value === undefined || flags.has(flag)) throw new AgentMuxError('Use each original Mesh option once.', 'INVALID_CLI_ARGUMENT')
      flags.set(flag, value)
    }
    if (['settings.mesh.configure', 'mesh.link'].includes(method) && !flags.has('--input')) throw new AgentMuxError('Use --input with the complete original Mesh request.', 'INVALID_CLI_ARGUMENT')
    const input = parseMeshNetworkParams(method, flags.has('--input') ? await readControlJsonInput(flags.get('--input')!, 'Original Mesh request') : {})
    if (flags.has('--host') !== flags.has('--expected-runtime') || input.target && flags.has('--host')) throw new AgentMuxError('Select the Mesh owner with both Host and Runtime once, in flags or JSON.', 'INVALID_CLI_ARGUMENT')
    if (flags.has('--host')) input.target = { hostId: flags.get('--host')!, expectedRuntimeId: flags.get('--expected-runtime')! }
    if (flags.has('--operation-id')) {
      if (method !== 'settings.mesh.inspect' || 'operationId' in input) throw new AgentMuxError('Select the original Mesh operation once, in flags or JSON.', 'INVALID_CLI_ARGUMENT')
      Object.assign(input, { operationId: flags.get('--operation-id') })
    }
    return parseMeshNetworkParams(method as MeshNetworkMethod, input) as unknown as Record<string, unknown>
  },
}))
