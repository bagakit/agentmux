import { AgentMuxError } from '@agentmux/core'
import type { ConnectionAdapter } from './connection-host.js'
import { FeishuPublicationAdapter } from './adapters/feishu/publication.js'
import { FEISHU_ENROLLMENT_PROTOCOL } from './adapters/feishu/enrollment-protocol.js'
import { DISCORD_PUBLICATION, prepareDiscordPublication } from './adapters/discord/render.js'
import { readDiscordActor } from './adapters/discord/profile.js'
import { createDiscordMetadataCache } from './adapters/discord/metadata.js'
import { createFeishuChannelProfiles } from './adapters/feishu/channel-profile.js'

/** Built-in leaves stay unloaded until an explicit adapter operation or receiver consumes them. */
export function createBuiltinConnectionAdapters(): readonly ConnectionAdapter[] {
  let feishuRetention = (_connectionId: string) => true
  let feishuClosed = false
  let feishuAdapter: import('./adapters/feishu/index.js').FeishuAdapter | undefined
  let loading: Promise<import('./adapters/feishu/index.js').FeishuAdapter> | undefined
  const feishu = () => loading ??= import('./adapters/feishu/index.js').then(({ FeishuAdapter }) => {
    feishuAdapter = new FeishuAdapter()
    feishuAdapter.setClientRetention(id => !feishuClosed && feishuRetention(id))
    return feishuAdapter
  }).catch(() => {
    loading = undefined
    throw new AgentMuxError('The connection adapter is unavailable. Existing Agents are retained.', 'CONNECTION_ADAPTER_UNAVAILABLE')
  })
  const adapter: ConnectionAdapter = {
    adapterId: 'feishu',
    setClientRetention: read => { feishuRetention = read },
    releaseConnection: connectionId => feishuAdapter?.releaseConnection(connectionId),
    close: () => { feishuClosed = true; feishuRetention = () => false; feishuAdapter?.close() },
    channelProfiles: createFeishuChannelProfiles(async (config, credential, call, signal) => (await feishu()).withClient(config, credential, call, signal)),
    profile: {
      get: async (config, revision, credential, signal) => (await feishu()).profile.get(config, revision, credential, signal)
    },
    setup: {
      domains: ['open.feishu.cn'],
      begin: async (input, signal) => (await feishu()).setup.begin(input, signal),
      advance: async (input, signal) => (await feishu()).setup.advance(input, signal),
      enrollmentContinuation: { domains: ['open.feishu.cn'], resume: async input => (await feishu()).setup.enrollmentContinuation!.resume(input) },
      applicationConfiguration: {
        domains: ['open.feishu.cn'],
        applicationProfile: {
          plan: async (...input) => (await feishu()).setup.applicationConfiguration!.applicationProfile!.plan(...input),
          uploadAvatar: async (...input) => (await feishu()).setup.applicationConfiguration!.applicationProfile!.uploadAvatar(...input),
          update: async (...input) => (await feishu()).setup.applicationConfiguration!.applicationProfile!.update(...input),
          publicationDraft: async (...input) => (await feishu()).setup.applicationConfiguration!.applicationProfile!.publicationDraft(...input)
        },
        initialPublicationDraft: async input => (await feishu()).setup.applicationConfiguration!.initialPublicationDraft!(input),
        publicationPlan: async (...input) => (await feishu()).setup.applicationConfiguration!.publicationPlan(...input),
        createVersion: async (input, signal) => (await feishu()).setup.applicationConfiguration!.createVersion(input, signal),
        submitVersion: async (input, signal) => (await feishu()).setup.applicationConfiguration!.submitVersion(input, signal),
        messagingCapability: async state => (await feishu()).setup.applicationConfiguration!.messagingCapability(state),
        eventTransportCapability: async state => (await feishu()).setup.applicationConfiguration!.eventTransportCapability(state),
        usePersistentConnection: async (input, signal) => (await feishu()).setup.applicationConfiguration!.usePersistentConnection(input, signal),
        callbackTransportCapability: async state => (await feishu()).setup.applicationConfiguration!.callbackTransportCapability!(state),
        usePersistentCallback: async (input, signal) => (await feishu()).setup.applicationConfiguration!.usePersistentCallback!(input, signal),
        cardActionsCapability: async state => (await feishu()).setup.applicationConfiguration!.cardActionsCapability!(state),
        addCardActions: async (input, signal) => (await feishu()).setup.applicationConfiguration!.addCardActions!(input, signal),
        permissionPlan: async (...input) => (await feishu()).setup.applicationConfiguration!.permissionPlan(...input),
        messageReceptionPlan: async (...input) => (await feishu()).setup.applicationConfiguration!.messageReceptionPlan(...input),
        addMessageReception: async (input, signal) => (await feishu()).setup.applicationConfiguration!.addMessageReception(input, signal),
        addApplicationPermissions: async (input, signal) => (await feishu()).setup.applicationConfiguration!.addApplicationPermissions(input, signal),
        enableMessaging: async (input, signal) => (await feishu()).setup.applicationConfiguration!.enableMessaging(input, signal)
      },
      applicationInspection: {
        domains: ['open.feishu.cn'],
        inspect: async (input, signal) => (await feishu()).setup.applicationInspection!.inspect(input, signal),
        read: async (input, signal) => (await feishu()).setup.applicationInspection!.read!(input, signal)
      }
    },
    enrollment: {
      protocolId: FEISHU_ENROLLMENT_PROTOCOL,
      domains: [{ domain: 'open.feishu.cn', label: 'Feishu' }],
      begin: async (input, signal) => (await feishu()).enrollment.begin(input, signal),
      advance: async (input, signal) => (await feishu()).enrollment.advance(input, signal),
      upload: async (input, signal) => (await feishu()).enrollment.upload(input, signal),
      create: async (input, signal) => (await feishu()).enrollment.create(input, signal),
      credential: async (input, signal) => (await feishu()).enrollment.credential(input, signal)
    },
    publication: new FeishuPublicationAdapter({ withClient: async (config, credential, call, signal) => (await feishu()).withClient(config, credential, call, signal) }),
    test: async (config, credential) => (await feishu()).test(config, credential),
    ingress: {
      adapterId: 'feishu',
      verify: async (config, raw, proof) => (await feishu()).verify(config, raw, proof),
      qualifyReply: async (config, event, raw, credential, signal) => (await feishu()).qualifyReply(config, event, raw, credential, signal),
      readHistory: async (...input) => (await feishu()).readHistory(...input)
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
  let discordClosed = false
  let discordRetention = (_connectionId: string) => true
  let discordAdapterOwner: import('./adapters/discord/index.js').DiscordAdapter | undefined
  let discordLoading: Promise<import('./adapters/discord/index.js').DiscordAdapter> | undefined
  const discord = () => discordLoading ??= import('./adapters/discord/index.js').then(({ DiscordAdapter }) => {
    discordAdapterOwner = new DiscordAdapter()
    discordAdapterOwner.setClientRetention(id => !discordClosed && discordRetention(id))
    return discordAdapterOwner
  }).catch(() => {
    discordLoading = undefined
    throw new AgentMuxError('The connection adapter is unavailable. Existing Agents are retained.', 'CONNECTION_ADAPTER_UNAVAILABLE')
  })
  const discordProfiles = createDiscordMetadataCache({ readActor: readDiscordActor })
  const discordAdapter: ConnectionAdapter = {
    adapterId: DISCORD_PUBLICATION.adapterId,
    setClientRetention: read => { discordRetention = read },
    releaseConnection: connectionId => discordAdapterOwner?.releaseConnection(connectionId),
    close: () => { discordClosed = true; discordRetention = () => false; discordAdapterOwner?.close() },
    test: async (...input) => (await discord()).test(...input),
    ingress: { adapterId: DISCORD_PUBLICATION.adapterId, verify: async (...input) => (await discord()).verify(...input), qualifyReply: async (...input) => (await discord()).qualifyReply(...input), readHistory: async (...input) => (await discord()).readHistory(...input) },
    transport: { start: async input => (await discord()).transport.start(input) },
    publication: { ...DISCORD_PUBLICATION, supportedRenderVersions: [DISCORD_PUBLICATION.renderVersion], prepare: prepareDiscordPublication,
      images: { maxBytes: 16 * 1024 * 1024, accepts: () => true }, files: { maxBytes: 16 * 1024 * 1024, accepts: () => true },
      dispatch: async (...input) => (await discord()).publication.dispatch(...input), inspect: async (...input) => (await discord()).publication.inspect(...input) },
    roomDiscovery: {
      list: async (...input) => (await discord()).roomDiscovery.list(...input), search: async (...input) => (await discord()).roomDiscovery.search(...input),
      get: async (...input) => (await discord()).roomDiscovery.get(...input), members: async (...input) => (await discord()).roomDiscovery.members(...input), createLink: async (...input) => (await discord()).roomDiscovery.createLink(...input)
    },
    channelProfiles: {
      readActor: input => readDiscordActor(input),
      refreshActor: async (...input) => (await discord()).channelProfiles.refreshActor(...input),
      getMetadata: input => discordProfiles.getMetadata!(input), listMetadata: input => discordProfiles.listMetadata!(input), clearMetadata: input => discordProfiles.clearMetadata!(input),
      refreshConversation: async (...input) => (await discord()).channelProfiles.refreshConversation!(...input)
    }
  }
  return [adapter, discordAdapter]
}
