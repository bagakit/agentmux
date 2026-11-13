import { AgentMuxError } from './errors.js'
import { connectAgentMuxRpc, agentMuxRpcEnvironmentCredentials, type AgentMuxRpcSubscriptionOptions } from './public-rpc-client.js'
import { AGENTMUX_RPC_CONTROL_METHODS, AGENTMUX_RPC_NATIVE_METHODS, isAgentMuxRpcMethod, type AgentMuxRpcCredentials, type AgentMuxRpcEndpoint,
  type AgentMuxRpcMethod, type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcStreamParams } from './public-rpc.js'

export type BrowserRpcMethod = Extract<AgentMuxRpcMethod, `browser.${string}`>
export type BrowserRpcCallMethod = Exclude<BrowserRpcMethod, 'browser.follow'>
export function isBrowserRpcMethod(value: unknown): value is BrowserRpcMethod {
  return isAgentMuxRpcMethod(value) && value.startsWith('browser.')
}
/** One machine catalog, inherited from Core's actual public registration. */
export const BROWSER_RPC_METHODS = [...Object.keys(AGENTMUX_RPC_CONTROL_METHODS), ...Object.keys(AGENTMUX_RPC_NATIVE_METHODS)].filter(isBrowserRpcMethod)
export function isBrowserRpcCallMethod(value: unknown): value is BrowserRpcCallMethod { return isBrowserRpcMethod(value) && value !== 'browser.follow' }
export const BROWSER_RPC_CALL_METHODS = BROWSER_RPC_METHODS.filter(isBrowserRpcCallMethod)

/** This adapter owns only a connection. Browser state, operations, permissions and gaps remain at the original service. */
export async function connectBrowserSdk(options: { endpoint: AgentMuxRpcEndpoint; credentials?: AgentMuxRpcCredentials }) {
  if (!options?.endpoint) throw new AgentMuxError('An explicit Browser RPC endpoint is required.', 'INVALID_CONTROL_REQUEST')
  const credentials = options.credentials ?? agentMuxRpcEnvironmentCredentials()
  const client = await connectAgentMuxRpc({ endpoint: options.endpoint, ...(credentials ? { credentials } : {}) })
  return {
    async discover(signal?: AbortSignal) {
      const endpoint = await client.call('system.endpoint', {}, signal ? { signal } : {})
      return { availability: endpoint.methods === undefined ? 'unknown' as const : 'advertised' as const,
        methods: endpoint.methods?.filter(isBrowserRpcMethod) ?? [...BROWSER_RPC_METHODS] }
    },
    call<M extends BrowserRpcCallMethod>(method: M, params: AgentMuxRpcParams<M>, options?: { signal?: AbortSignal }): Promise<AgentMuxRpcResult<M>> {
      if (!isBrowserRpcCallMethod(method)) throw new AgentMuxError('Use an original Browser method; follow uses its stream API.', 'INVALID_CONTROL_REQUEST')
      return client.call(method, params, options)
    },
    follow(params: AgentMuxRpcStreamParams<'browser.follow'>, options: AgentMuxRpcSubscriptionOptions<'browser.follow'>) {
      return client.subscribe('browser.follow', params, options)
    },
    dispose: () => client.dispose()
  }
}
export type BrowserSdk = Awaited<ReturnType<typeof connectBrowserSdk>>
