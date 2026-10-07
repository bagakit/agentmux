import { AgentMuxError } from '@agentmux/core'
import type { ConnectionAdapter } from './connection-host.js'
import { FeishuPublicationAdapter } from './adapters/feishu/publication.js'

/** Built-in leaves stay unloaded until the original Host tests or starts an enabled connection. */
export function createBuiltinConnectionAdapters(): readonly ConnectionAdapter[] {
  let loading: Promise<import('./adapters/feishu/index.js').FeishuAdapter> | undefined
  const feishu = () => loading ??= import('./adapters/feishu/index.js').then(({ FeishuAdapter }) => new FeishuAdapter()).catch(() => {
    loading = undefined
    throw new AgentMuxError('The connection adapter is unavailable. Existing Agents are retained.', 'CONNECTION_ADAPTER_UNAVAILABLE')
  })
  const adapter: ConnectionAdapter = {
    adapterId: 'feishu',
    publication: new FeishuPublicationAdapter({ withClient: async (config, credential, call, signal) => (await feishu()).withClient(config, credential, call, signal) }),
    test: async (config, credential) => (await feishu()).test(config, credential),
    ingress: {
      adapterId: 'feishu',
      verify: async (config, raw, proof) => (await feishu()).verify(config, raw, proof),
      qualifyReply: async (config, event, raw, credential, signal) => (await feishu()).qualifyReply(config, event, raw, credential, signal)
    },
    transport: { start: async input => (await feishu()).transport.start(input) }
  }
  return [adapter]
}
