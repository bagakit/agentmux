import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AgentMuxControlServer, connectAgentMuxRpc, type MoteConnectionCreate } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { createDesktopConnections } from '../../src/main/connector-host.js'
import { MoteConnectionOperations } from '../../src/main/mote-connection-operations.js'
import { MoteConnectionSourceOwner } from '../../src/main/mote-connection-source.js'
import { MoteConnectionPreferences } from '../../src/main/mote-connection-preferences.js'
import { ScratchTopics } from '../../src/main/scratch-topics.js'
import { FileReadOwner } from '../../src/main/file-read-owner.js'
import { NoteFileWriter } from '../../src/main/note-file-writer.js'
import { WorkspaceFiles } from '../../src/main/workspace-files.js'
import { ConfigOwner } from '../../src/main/config-owner.js'
import { MoteAvatarWriter } from '../../src/main/mote-avatar-writer.js'
import { MoteAvatarControl } from '../../src/main/mote-avatar-control.js'
import type { MoteAvatarSeriesOwner } from '../../src/main/mote-avatar-series.js'
import type { AppConfig } from '../../src/shared/contracts.js'
import { directoryIdentity, homeZoneId } from '../../src/shared/space-addresses.js'
import { SCRATCH_WORKSPACE_ID } from '../../src/shared/scratch-topics.js'
import { controlledNativeImage, imageInput } from './mote-identity-image.js'
import type { ConnectionAdapter } from '@agentmux/connectors'

export async function moteConnectionOwner(
  root: string,
  options: {
    generic?: boolean
    loseFileAck?: boolean
    afterFileWrite?(): Promise<void>
    pollUnknown?: boolean
    profileUnknown?: boolean
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
    appearance: { spaceObjectIcons: Object.fromEntries(motes.map((m) => [m.spaceId, m.avatar])) },
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
    save: async () => {
      throw new Error('No avatar edits')
    },
    confirm: async () => {
      throw new Error('No config edits')
    }
  })
  const avatars = new MoteAvatarControl(sources, writer)
  const counts = { begin: 0, poll: 0, upload: 0, patch: 0 }
  const effect = async (kind: keyof typeof counts) => {
    counts[kind]++
    await appendFile(join(root, 'platform-effects'), kind + '\n')
  }
  const adapter: ConnectionAdapter = {
    adapterId: 'signed-profile',
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
          kind: 'pending',
          verificationUrl: 'https://signed.example/verify',
          privateState: JSON.stringify({ operationId: input.operationId }),
          expiresInMs: null,
          pollIntervalMs: 0
        }
      },
      poll: async (input) => {
        if (JSON.parse(input.privateState).operationId !== input.operationId) throw new Error('Wrong original challenge')
        await effect('poll')
        return options.pollUnknown
          ? { kind: 'unknown' }
          : {
              kind: 'authorized',
              application: { domain: input.domain, appId: 'app-' + input.connectionId },
              secret: 'private-test-credential'
            }
      }
    },
    profile: {
      prepareUpload: (c, png) => ({ format: 'signed-image', body: JSON.stringify({ app: c.application, png }) }),
      upload: async () => {
        await effect('upload')
        return { state: 'confirmed', avatarUrl: 'https://signed.example/avatar.png' }
      },
      preparePatch: (c, desired, avatarUrl) => ({
        format: 'signed-patch',
        body: JSON.stringify({ app: c.application, desired, avatarUrl })
      }),
      patch: async () => {
        await effect('patch')
        return options.profileUnknown ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'confirmed' }
      },
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
  const key = Buffer.alloc(32, 4),
    encryption = {
      isEncryptionAvailable: () => true,
      encryptString: (v: string) => {
        const iv = randomBytes(12),
          c = createCipheriv('aes-256-gcm', key, iv)
        return Buffer.concat([iv, c.update(v, 'utf8'), c.final(), c.getAuthTag()])
      },
      decryptString: (v: Buffer) => {
        const c = createDecipheriv('aes-256-gcm', key, v.subarray(0, 12))
        c.setAuthTag(v.subarray(-16))
        return Buffer.concat([c.update(v.subarray(12, -16)), c.final()]).toString()
      }
    }
  const connections = await createDesktopConnections({
    directory: join(root, 'connections'),
    encryption,
    ...(options.generic ? { adapters: [adapter] } : {})
  })
  const preferences = new MoteConnectionPreferences({
    files: publicFiles,
    catalog,
    connections: () => connections.connections.list(),
    quick: async () => {
      throw new Error('No Renderer or Agent required')
    }
  })
  const sourcePorts: ConstructorParameters<typeof MoteConnectionSourceOwner>[0] = {
    catalog,
    workspace: (id) => (id === workspace.id ? workspace : undefined),
    topicForDirectory: (w, d) => topics.readForDirectory(w, d),
    files: publicFiles,
    avatars
  }
  const source = new MoteConnectionSourceOwner(sourcePorts)
  const parent = new MoteConnectionOperations({ connections, preferences, source })
  const server = new AgentMuxControlServer({
    socketPath: join(root, 'owner.sock'),
    files: publicFiles,
    moteAvatars: avatars,
    execute: request => {
      if (request.operation === 'space.mote.preferences.read' || request.operation === 'space.mote.preferences.save') return preferences.execute(request)
      throw new Error('Only original Mote preference requests are routed by this fixture')
    },
    moteConnections: parent,
    connections: connections.connections,
    coreClients: () => {
      throw new Error('No Runtime may be borrowed')
    }
  })
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
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
      source: { target: t, expectedTopicRevision: topic.result.document.revision, expectedAvatarRevision: avatar.revision },
      avatar: 'include-saved',
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
    source,
    sourcePorts,
    parent,
    preferences,
    connections,
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
      await client.dispose()
      await server.stop()
      parent.close()
      connections.close()
      await files.dispose()
    }
  }
}
