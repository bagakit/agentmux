import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc, type MoteConnectionCreate } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { createConnectionServices } from '../../../../packages/connectors/src/connection-services.js'
import { MoteConnectionOperations } from '@agentmux/connectors'
import { MoteConnectionTargetOwner } from '../../src/main/mote-connection-target.js'
import { MoteConnectionPreferences } from '@agentmux/host/mote-connection-preferences'
import { ScratchTopics } from '../../src/main/scratch-topics.js'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../../src/main/workspace-files.js'
import { ConfigOwner } from '../../src/main/config-owner.js'
import { MoteAvatarWriter } from '../../src/main/mote-avatar-writer.js'
import { MoteAvatarControl } from '../../src/main/mote-avatar-control.js'
import type { MoteAvatarSeriesOwner } from '../../src/main/mote-avatar-series.js'
import type { AppConfig } from '../../src/shared/contracts.js'
import type { SpaceIconChoice } from '../../src/shared/space-object-appearance.js'
import type { MoteAvatarImage } from '../../src/shared/mote-avatars.js'
import { directoryIdentity, homeZoneId } from '../../src/shared/space-addresses.js'
import { SCRATCH_WORKSPACE_ID, topicPublicCopy } from '../../src/shared/scratch-topics.js'
import { controlledNativeImage, imageInput } from './mote-identity-image.js'
import { createBuiltinConnectionAdapters, type ConnectionAdapter } from '@agentmux/connectors'
import type { ConnectionEnrollmentActionKind } from '@agentmux/core/connections'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


export async function moteConnectionOwner(
  root: string,
  options: {
    generic?: boolean
    loseFileAck?: boolean
    afterFileWrite?(): Promise<void>
    authenticationUnknown?: boolean
    avatarChoice?: SpaceIconChoice | null
    renderAvatar?(svg: string): Promise<MoteAvatarImage>
    chatReadiness?(): Promise<void>
  } = {}
) {
  const workspace = {
    id: SCRATCH_WORKSPACE_ID,
    name: 'Original Motes',
    hostId: 'local',
    path: join(root, 'scratch'),
    kind: 'folder' as const
  }
  await mkdir(workspace.path, { recursive: true })
  const topics = new ScratchTopics(controlledNativeImage),
    marker = join(root, 'fixture.json')
  let saved: { id: string; directory: string; identity: string; avatar: { kind: 'image'; fileName: string } }[]
  try {
    saved = JSON.parse(await readFile(marker, 'utf8'))
  } catch {
    saved = []
    for (const id of ['view:profile-one', 'view:profile-two']) {
      const mote = await topics.ensureMote(workspace, id),
        directory = mote.physicalDirectoryPath!,
        identity = mote.identityDirectoryPath!
      await writeFile(join(directory, 'topic.md'), '# Saved public name\n\nSaved public summary.\n')
      await writeFile(join(directory, 'SOUL.md'), '# Private personality\nDO-NOT-PUBLISH-SOUL\n')
      await writeFile(join(directory, 'MOTE.md'), '---\nversion: 1\n---\nOriginal notes.\n')
      const avatar = await topics.saveAvatar(workspace, id, imageInput(), directoryIdentity('local', identity))
      saved.push({ id, directory, identity, avatar })
    }
    await writeFile(marker, JSON.stringify(saved))
  }
  const motes = saved.map((m) => ({
    ...m,
    spaceId: directoryIdentity('local', m.identity),
    zoneId: homeZoneId(directoryIdentity('local', m.identity))
  }))
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  if (!(await spatial.read()))
    await spatial.commit({
      expectedRevision: 0,
      graph: {
        spaces: motes.map((m) => ({
          spaceId: m.spaceId,
          kind: 'mote',
          name: 'Same display name',
          hostId: 'local',
          directoryPath: m.directory,
          projectId: null,
          topicId: m.id
        })),
        zones: motes.map((m) => ({
          zoneId: m.zoneId,
          workspaceId: workspace.id,
          kind: 'home',
          hostId: 'local',
          directoryPath: m.directory,
          branch: null
        })),
        bindings: motes.map((m) => ({ spaceId: m.spaceId, zoneId: m.zoneId })),
        tabs: [],
        regions: [],
        layouts: {},
        tabLayouts: {},
        resources: {}
      }
    })
  const catalog = async () => spatialCatalog((await spatial.read())!.graph)
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never),
    notes = new NoteFileWriter(files)
  let writes = 0
  const publicFiles = new FileReadOwner({
    catalog,
    workspace: (id) => (id === workspace.id ? workspace : undefined),
    topicForDirectory: (w, d) => topics.readForDirectory(w, d),
    files: {
      read: notes.read.bind(notes),
      listFiles: files.listFiles.bind(files),
      write: async (...args) => {
        writes++
        const receipt = await notes.write(...args)
        await appendFile(join(root, 'file-effects'), JSON.stringify({ status: receipt.status }) + '\n')
        if (options.afterFileWrite) await options.afterFileWrite()
        if (options.loseFileAck) throw new Error('Original File acknowledgement unavailable')
        return receipt
      }
    }
  })
  const config = {
    appearance: { spaceObjectIcons: Object.fromEntries(motes.map((m) => [m.spaceId, Object.hasOwn(options, 'avatarChoice') ? options.avatarChoice : m.avatar])) },
    workspaces: [workspace]
  } as AppConfig
  const configOwner = new ConfigOwner({
    read: () => config,
    save: async () => {
      throw new Error('This consumer only reads saved appearance')
    },
    publish: () => {}
  })
  const sources = {
    preview: async () => {
      throw new Error('No generated avatar or series fallback')
    }
  } as unknown as MoteAvatarSeriesOwner
  const writer = new MoteAvatarWriter(configOwner, sources, {
    directory: (t) => topics.avatarTargetDirectory(workspace, t.topicId, t.objectKey),
    read: (t, ref) => topics.readAvatar(workspace, t.topicId, ref, t.objectKey),
    render: options.renderAvatar ?? (async () => { throw new Error('This fixture did not provide a native SVG raster boundary') }),
    prefersDark: () => true,
    save: async () => {
      throw new Error('No avatar edits')
    },
    confirm: async () => {
      throw new Error('No config edits')
    }
  })
  const avatars = new MoteAvatarControl(sources, writer)
  const counts = { begin: 0, authentication: 0, creationUpload: 0, create: 0, credential: 0, upload: 0, patch: 0 }
  const effect = async (kind: keyof typeof counts) => {
    counts[kind]++
    await appendFile(join(root, 'platform-effects'), kind + '\n')
  }
  const adapter: ConnectionAdapter = {
    adapterId: 'signed-profile',
    ingress: { adapterId: 'signed-profile', verify: async (_config, raw, proof) => { if (proof !== 'controlled-signed-proof') throw new Error('Original native proof is required'); return JSON.parse(raw) } },
    test: async () => ({
      authentication: { state: 'unknown' },
      transport: { state: 'unknown' },
      intake: { state: 'unknown' },
      delivery: { state: 'unknown' }
    }),
    enrollment: {
      domains: [{ domain: 'signed.example', label: 'Signed profile' }],
      begin: async (input) => {
        await effect('begin')
        return {
          kind: 'authentication',
          stage: 'waiting',
          challenge: { qrPayload: 'original-signed-private-qr', expiresAt: null, nextPollAt: _historyFixtureEpoch(0, 0, 0) },
          account: null,
          privateState: JSON.stringify({ operationId: input.operationId }),
        }
      },
      advance: async (input) => {
        if (JSON.parse(input.privateState).operationId !== input.operationId) throw new Error('Wrong original challenge')
        await effect('authentication')
        return options.authenticationUnknown
          ? { kind: 'unknown', diagnostic: { stage: 'adapter', code: 'receipt-unconfirmed' } }
          : {
              kind: 'authentication', stage: 'account', challenge: null,
              account: { userId: 'original-user', tenantId: 'original-tenant' },
              privateState: input.privateState
            }
      },
      upload: async input => { await effect('creationUpload'); return { kind: 'uploaded', privateState: input.privateState } },
      create: async input => { await effect('create'); return { kind: 'created', application: { domain: input.domain, appId: 'app-' + input.connectionId }, privateState: input.privateState } },
      credential: async input => { await effect('credential'); return { kind: 'credential', secret: 'private-test-credential', privateState: input.privateState } }
    },
    profile: {
      get: async (c, revision) => ({
        connectionId: c.connectionId,
        connectionRevision: revision,
        application: c.application,
        language: null,
        state: 'unknown',
        profile: null,
        metadata: null,
        botId: null,
        onlineVersionId: null,
        reviewingVersionId: null,
        version: null,
        reason: 'online-unconfirmed'
      })
    }
  }
  const adapters = options.generic ? [adapter] : createBuiltinConnectionAdapters()
  const chatAgentCalls = { prepare: 0, create: 0, inspect: 0, prepareInput: 0, activity: 0 }
  const unavailableChatAgent = (kind: keyof typeof chatAgentCalls) => async () => { chatAgentCalls[kind]++; throw new Error('Profile metadata and settings must not create or borrow a Runtime') }
  const connections = await createConnectionServices({
    directory: join(root, 'connections'),
    adapters,
    moteChat: { assertTarget: async target => { if ((await preferences.read({ kind: 'connection', target })).status !== 'ready') throw new Error('The exact original Mote home is unconfirmed') },
      ...(options.chatReadiness ? { assertReady: options.chatReadiness } : {}),
      agents: { prepare: unavailableChatAgent('prepare'), create: unavailableChatAgent('create'), inspect: unavailableChatAgent('inspect'), prepareInput: unavailableChatAgent('prepareInput'), activity: unavailableChatAgent('activity') } },
    ...(options.generic ? { bindings: { spatial, checkpoint: async () => { throw new Error('Profile settings must not borrow a conversation checkpoint') } }, ingress: { core: () => undefined } } : {})
  })
  const preferences = new MoteConnectionPreferences({
    files: publicFiles,
    catalog,
    connections: () => connections.connections.list()
  })
  const sourcePorts: ConstructorParameters<typeof MoteConnectionTargetOwner>[0] = {
    catalog,
    workspace: (id) => (id === workspace.id ? workspace : undefined),
    topicForDirectory: (w, d) => topics.readForDirectory(w, d)
  }
  const source = new MoteConnectionTargetOwner(sourcePorts)
  // The finite parent consumes the original owners through only their existing structure ports.
  const parent = new MoteConnectionOperations({
    connections: { connections: connections.connections, openDatabase: () => connections.openDatabase() },
    assertTarget: target => source.assertTarget(target),
    preferences: { read: input => preferences.read(input), save: (input, context) => preferences.save(input, context) }
  })
  const moteChat = connections.moteChat!
  const server = new AgentMuxControlServer({
    socketPath: join(root, 'owner.sock'),
    files: publicFiles,
    moteAvatars: avatars,
    motePreferences: preferences,
    moteConnections: parent,
    moteChat,
    connections: connections.connections,
    coreClients: () => {
      throw new Error('No Runtime may be borrowed')
    }
  })
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const service = await client.call('connection.service.get', {})
  if (service.enabled) await client.call('connection.service.configure', { operationId: 'fixture-service-off', expectedRevision: service.revision, service: { enabled: false } })
  const target = (index = 0) => ({
    spaceId: motes[index]!.spaceId,
    zoneId: motes[index]!.zoneId,
    expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path }
  })
  const input = async (operationId = 'mote-original', index = 0): Promise<MoteConnectionCreate> => {
    const t = target(index),
      topic = await publicFiles.read({ ...t, path: 'topic.md' })
    if (topic.result.status !== 'read') throw new Error('Exact original saved topic is missing')
    const avatar = await avatars.call('space.mote.avatar.read', {
      target: { workspaceId: workspace.id, topicId: motes[index]!.id, objectKey: t.spaceId }
    })
    return {
      operationId,
      source: { target: t, preparedFrom: { topicRevision: topic.result.document.revision, avatarRevision: avatar.revision } },
      desired: { name: topicPublicCopy(topic.result.document.content).title!, description: topicPublicCopy(topic.result.document.content).summary ?? '', avatar: { pngDataUrl: avatar.image!.dataUrl } },
      adapterId: options.generic ? 'signed-profile' : 'feishu',
      domain: options.generic ? 'signed.example' : 'open.feishu.cn'
    }
  }
  return {
    root,
    workspace,
    motes,
    spatial,
    files,
    publicFiles,
    topics,
    avatars,
    config,
    source,
    sourcePorts,
    parent,
    moteChat,
    chatAgentCalls,
    preferences,
    connections,
    adapters,
    server,
    client,
    target,
    input,
    counts,
    adapter,
    get writes() {
      return writes
    },
    close: async () => {
      const errors: unknown[] = []
      for (const close of [() => client.dispose(), () => server.stop(), () => parent.close(), () => connections.close(), () => files.dispose()]) { try { await close() } catch (error) { errors.push(error) } }
      if (errors.length) throw new AggregateError(errors, 'Mote original owner cleanup failed')
    }
  }
}

/** Test intent consumes the actual original child action; it does not infer consent from a parent summary. */
export async function moteChildDecision(owner: Pick<Awaited<ReturnType<typeof moteConnectionOwner>>, 'client'>, operationId: string, kind: ConnectionEnrollmentActionKind) {
  const parent = (await owner.client.call('space.mote.connection.inspect', { operationId })).operation
  if (!parent?.enrollmentOperationId) throw new Error('Original Mote enrollment is unavailable')
  const view = await owner.client.call('connection.enrollment.inspect', { operationId: parent.enrollmentOperationId })
  const choices = view.actions.filter(action => action.kind === kind)
  if (choices.length !== 1 || !view.operation) throw new Error('The exact original enrollment action is not offered: ' + kind)
  if (kind === 'continue-authentication' && view.challenge && view.challenge.nextPollAt > Date.now()) await new Promise(resolve => setTimeout(resolve, view.challenge!.nextPollAt - Date.now()))
  const action = choices[0]!
  return { operationId, enrollment: { operationId: view.operation.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind } } }
}

export async function confirmAndCreateMote(owner: Pick<Awaited<ReturnType<typeof moteConnectionOwner>>, 'client'>, operationId: string) {
  let parent = (await owner.client.call('space.mote.connection.inspect', { operationId })).operation
  for (let step = 0; step < 8 && parent?.enrollment?.authentication?.stage !== 'account'; step++) parent = await owner.client.call('space.mote.connection.advance', await moteChildDecision(owner, operationId, 'continue-authentication'))
  await owner.client.call('space.mote.connection.advance', await moteChildDecision(owner, operationId, 'confirm-account'))
  return owner.client.call('space.mote.connection.advance', await moteChildDecision(owner, operationId, 'create'))
}
