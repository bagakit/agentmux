import { AgentMuxError } from './errors.js'
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js'
import { parseHostRouteParams } from './host-route.js'
import { readControlJsonInput } from './cli-json-input.js'

/** Business configuration and exact-call consumers; receive/endorsement is an SDK carrier. */
export const HOST_ROUTE_CLI_COMMANDS: readonly AgentMuxCliCommand[] = (['route.identity', 'route.inspect', 'route.configure', 'route.call', 'route.watch'] as const).map(method => ({
  method, usage: method === 'route.identity' || method === 'route.inspect' ? '' : '--input FILE|-',
  summary: method === 'route.identity' ? 'Read this actual Core route signing identity.' : method === 'route.inspect' ? 'Read this Core configured routes, receiver grants and observed original save operation.' : method === 'route.configure' ? 'Explicitly save original route/receiver policy with exact revision and operation ID; user/device only.' : method === 'route.call' ? 'Call one finite original method over an explicitly adopted configured chain; never retries.' : 'Observe one original method over its explicitly adopted configured chain.',
  ...(method === 'route.watch' ? { stream: true } : {}),
  details: 'Route IDs/edges belong to their original Core; Runtime/key pins are not aliases. A configured connection grants no transit permission. Each receiver must approve the immediate delegator, original actor, destination and exact finite method. runtime.invoke requires an allowed inner method. Input never supplies credentials, principal or arbitrary endpoint. Call/watch input contains routeId, adoptedRoute, requestId and call:{method,params}; requestId is correlation only, original business operation IDs stay inside params. Configuration input contains expectedRevision, operationId, configuration:{routes,grants}. Readback observes the saved operation; only configure returns its original durability ACK. Retain unknown operations and inspect the same original owner; do not replay, reroute or substitute a new Session. Reader cancel/revocation does not stop an admitted operation or healthy Run.',
  parse: async args => {
    const read = method === 'route.identity' || method === 'route.inspect'
    if (read ? args.length !== 0 : args.length !== 2 || args[0] !== '--input') throw new AgentMuxError('Use the exact route command arguments; read --help.', 'INVALID_CLI_ARGUMENT')
    return parseHostRouteParams(method, read ? {} : await readControlJsonInput(args[1]!, 'Original route request')) as Record<string, unknown>
  },
}))
