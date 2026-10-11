import { AgentMuxError } from '@agentmux/core'
import type { ConnectionAdapter } from './connection-host.js'
import { FeishuPublicationAdapter } from './adapters/feishu/publication.js'

/** Built-in leaves stay unloaded until an explicit adapter operation or receiver consumes them. */
export function createBuiltinConnectionAdapters(): readonly ConnectionAdapter[] {
  let loading: Promise<import('./adapters/feishu/index.js').FeishuAdapter> | undefined
  const feishu = () => loading ??= import('./adapters/feishu/index.js').then(({ FeishuAdapter }) => new FeishuAdapter()).catch(() => {
    loading = undefined
    throw new AgentMuxError('The connection adapter is unavailable. Existing Agents are retained.', 'CONNECTION_ADAPTER_UNAVAILABLE')
  })
  const adapter: ConnectionAdapter = {
    adapterId: 'feishu',
    profile: {
      prepareUpload: async (config, pngDataUrl) => (await feishu()).profile.prepareUpload(config, pngDataUrl),
      preparePatch: async (config, desired, avatarUrl, credential, signal) => (await feishu()).profile.preparePatch(config, desired, avatarUrl, credential, signal),
      upload: async (config, request, credential, signal) => (await feishu()).profile.upload(config, request, credential, signal),
      patch: async (config, request, credential, signal) => (await feishu()).profile.patch(config, request, credential, signal),
      get: async (config, revision, credential, signal) => (await feishu()).profile.get(config, revision, credential, signal)
    },
    setup: {
      domains: ['open.feishu.cn'],
      begin: async (input, signal) => (await feishu()).setup.begin(input, signal),
      advance: async (input, signal) => (await feishu()).setup.advance(input, signal),
      applicationInspection: {
        domains: ['open.feishu.cn'],
        inspect: async (input, signal) => (await feishu()).setup.applicationInspection!.inspect(input, signal)
      }
    },
    enrollment: {
      domains: [{ domain: 'open.feishu.cn', label: 'Feishu' }, { domain: 'open.larksuite.com', label: 'Lark' }],
      begin: async (input, signal) => (await feishu()).enrollment.begin(input, signal),
      poll: async (input, signal) => (await feishu()).enrollment.poll(input, signal)
    },
    publication: new FeishuPublicationAdapter({ withClient: async (config, credential, call, signal) => (await feishu()).withClient(config, credential, call, signal) }),
    test: async (config, credential) => (await feishu()).test(config, credential),
    ingress: {
      adapterId: 'feishu',
      verify: async (config, raw, proof) => (await feishu()).verify(config, raw, proof),
      qualifyReply: async (config, event, raw, credential, signal) => (await feishu()).qualifyReply(config, event, raw, credential, signal)
    },
    transport: { start: async input => (await feishu()).transport.start(input) },
    roomDiscovery: {
      list: async (input, credential, signal) => (await feishu()).roomDiscovery.list(input, credential, signal),
      search: async (input, credential, signal) => (await feishu()).roomDiscovery.search(input, credential, signal),
      get: async (input, credential, signal) => (await feishu()).roomDiscovery.get(input, credential, signal),
      members: async (input, credential, signal) => (await feishu()).roomDiscovery.members(input, credential, signal),
      createLink: async (input, credential, signal) => (await feishu()).roomDiscovery.createLink(input, credential, signal)
    },
    rooms: {
      create: async (input, credential, signal) => (await feishu()).rooms.create(input, credential, signal),
      addMembers: async (input, credential, signal) => (await feishu()).rooms.addMembers(input, credential, signal)
    }
  }
  return [adapter]
}
