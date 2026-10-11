import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { ConfigStore, DEFAULT_CONFIG, ConfigOwner, ScratchTopics, directoryIdentity, MoteAvatarSeriesOwner, MoteAvatarControl, createMoteAvatarWriter } from '../mote-avatar-series/writer-entry'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import type { MoteAvatarRead } from '@agentmux/core/mote-avatar-write'
import type { MoteAvatarSeriesCatalog, MoteAvatarSeriesPrepared } from '@agentmux/core/mote-avatar-series'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../src/shared/contracts'

export type AvatarLayeringSeed = { workspace: WorkspaceRecord; topic: ScratchTopicSnapshot; baseline: MoteAvatarRead;
  catalog: MoteAvatarSeriesCatalog; prepared: MoteAvatarSeriesPrepared[]; sourceInputs: Record<string, string> }

/** Original isolated filesystem/source owners and original GLB bytes; no avatar renderer or saved receipt is fabricated. */
export async function createAvatarLayeringSeed(root: string) {
  const builtinRoot = join(process.cwd(), 'apps/desktop/resources/avatar-series'), userRoot = join(root, 'avatar-series')
  await mkdir(userRoot, { recursive: true })
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(root, 'avatar-workspace'), name: 'Original private Mote', kind: 'folder' }
  const topics = new ScratchTopics(), topic = await topics.ensureMote(workspace, PMO_TEAMS_TOPIC_ID)
  assert.ok(topic.identityDirectoryPath?.startsWith(root), 'The original Mote seed stays in this exact private proof root')
  const target = { workspaceId: workspace.id, topicId: topic.id, objectKey: directoryIdentity(workspace.hostId, topic.identityDirectoryPath!) }
  const store = new ConfigStore(join(root, 'avatar-config.json'))
  let config = await store.save({ ...structuredClone(DEFAULT_CONFIG), workspaces: [workspace],
    appearance: { ...structuredClone(DEFAULT_CONFIG.appearance), spaceObjectIcons: { [target.objectKey]: 'rocket' } } })
  let writes = 0
  const configOwner = new ConfigOwner({ read: () => config, save: next => { writes++; return store.save(next) }, publish: saved => { config = saved } })
  const sources = new MoteAvatarSeriesOwner({ builtinRoot, userRoot })
  const control = new MoteAvatarControl(sources, createMoteAvatarWriter(configOwner, sources, topics, store))
  const baseline = await control.call('space.mote.avatar.read', { target }), catalog = await control.call('space.mote.avatar.list', {})
  const geometry = catalog.series.find(series => series.origin === 'builtin' && series.seriesId === 'geometry')
  assert.ok(geometry?.entries.some(entry => entry.definition.kind === 'glb'), 'The original declared geometry source must contain a real GLB')
  const prepared = await Promise.all(geometry.entries.map(entry => control.call('space.mote.avatar.preview', {
    source: { origin: geometry.origin, seriesId: geometry.seriesId, entryId: entry.entryId } })))
  const sourceInputs: Record<string, string> = {}
  for (const entry of await readdir(builtinRoot, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name)
    sourceInputs[relative(process.cwd(), file)] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  const seed: AvatarLayeringSeed = { workspace, topic, baseline, catalog, prepared, sourceInputs }
  return { seed, async verifyUnchanged() {
    assert.equal(writes, 0, 'Cancel never publishes a private original avatar/configuration write')
    for (const [file, digest] of Object.entries(sourceInputs)) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), digest,
      'Original avatar source bytes remain unchanged: ' + file)
    assert.deepEqual(await control.call('space.mote.avatar.read', { target }), baseline, 'The original saved avatar identity and revision remain unchanged')
  } }
}
