import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat } from 'node:fs/promises'
import { AgentMuxError, durableWriteFile } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { AgentMuxSpatialGraph, AgentMuxSpatialState, SpatialJson } from '@agentmux/core/spatial-graph'
import type { TopicCategory, TopicMigrationPreview, TopicMigrationReceipt, TopicUnavailable } from '@agentmux/core/control'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../shared/contracts'
import { scratchTopicPhysicalPath, scratchTopicStorageRoots } from '../shared/scratch-topics'
import type { TopicSpatialPort, TopicSpatialInspection, TopicSpatialIdentity } from './topic-knowledge'
import { directoryIdentity } from '../shared/space-addresses'
import { categoryResource, categorySpaceFact, categoriesFromSpatial, isKnowledgeTopic, topicContentSpaceId, topicContentZoneId,
  UNCLASSIFIED_TOPIC_CATEGORY_ID } from '../shared/topic-categories'

const resource = (value: unknown): SpatialJson => JSON.parse(JSON.stringify(value)) as SpatialJson
const emptyGraph = (): AgentMuxSpatialGraph => ({ spaces: [], zones: [], bindings: [], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} })
function error(message: string, code: string): never { throw new AgentMuxError(message, code) }

export function registerTopicCategory(graph: AgentMuxSpatialGraph, category: TopicCategory): void {
  const fact = categorySpaceFact(category)
  const index = graph.spaces.findIndex(space => space.spaceId === category.spaceId)
  if (index < 0) graph.spaces.push(fact)
  else graph.spaces[index] = fact
  graph.resources['space:' + category.spaceId] = categoryResource(category)
}

/** One explicit topology conversion. No file, layout, Region, execution or content identity is moved. */
export function registerKnowledgeTopic(graph: AgentMuxSpatialGraph, workspace: WorkspaceRecord,
  topic: ScratchTopicSnapshot, category: TopicCategory): void {
  const contentId = topicContentSpaceId(workspace, topic), zoneId = topicContentZoneId(workspace, topic)
  registerTopicCategory(graph, category)
  const existing = graph.zones.find(zone => zone.zoneId === zoneId)
  if (existing && (existing.workspaceId !== workspace.id || existing.hostId !== null && existing.hostId !== workspace.hostId))
    error('The original Topic Zone contradicts its resource. Its workface is retained; inspect the exact Zone.', 'TOPIC_ZONE_CONTEXT_CONFLICT')
  if (!existing) graph.zones.push({ zoneId, workspaceId: workspace.id, kind: 'home', hostId: workspace.hostId,
    directoryPath: scratchTopicPhysicalPath(workspace, topic), branch: null })
  // Every old Space relation is retained in the Category, including legal foreign Zones.
  graph.bindings = graph.bindings.map(binding => binding.spaceId === contentId ? { ...binding, spaceId: category.spaceId } : binding)
  if (!graph.bindings.some(binding => binding.zoneId === zoneId && binding.spaceId === category.spaceId))
    graph.bindings.push({ zoneId, spaceId: category.spaceId })
  graph.bindings = [...new Map(graph.bindings.map(binding => [JSON.stringify(binding), binding])).values()]
  graph.spaces = graph.spaces.filter(space => space.spaceId !== contentId)
  const original = graph.resources['zone:' + zoneId]
  const origin = original && typeof original === 'object' && !Array.isArray(original) ? original : {}
  graph.resources['zone:' + zoneId] = resource({ ...origin, spaceId: contentId, workspaceId: workspace.id, topicId: topic.id, contentKind: 'topic' })
  // tab.space is its original resource context, not a display parent. It remains unchanged.
}

type Ports = {
  state: AgentMuxSpatialStateStore
  workspace(): WorkspaceRecord
  topics(): Promise<ScratchTopicSnapshot[]>
  categories(): Promise<TopicCategory[]>
  ensureDefaultCategory(): Promise<TopicCategory>
}

/** Host adapter over the existing Core spatial owner, shared by GUI and public CUI. */
export class TopicSpatialOwner implements TopicSpatialPort {
  constructor(private readonly ports: Ports) {}
  async inspect(topic: TopicSpatialIdentity) {
    const workspace = this.ports.workspace()
    const state = await this.ports.state.read()
    if (state?.graph.spaces.some(space => space.kind === 'mote' && space.topicId === topic.id))
      error('The original Core identity belongs to a Mote. Its workface and content are retained.', 'TOPIC_TARGET_IS_MOTE')
    const original = state?.graph.zones.filter(zone => { const origin = state.graph.resources['zone:' + zone.zoneId]; return origin && typeof origin === 'object' && !Array.isArray(origin) && origin.topicId === topic.id && zone.workspaceId === workspace.id }) ?? []
    if (topic.readError && original.length !== 1) error('The original Topic identity is currently unconfirmed. Its workface and content are retained.', 'TOPIC_IDENTITY_UNCONFIRMED')
    const zoneId = topic.readError ? original[0]!.zoneId : topicContentZoneId(workspace, topic)
    const origin = state?.graph.resources['zone:' + zoneId]
    if (origin && typeof origin === 'object' && !Array.isArray(origin) && origin.contentKind === 'mote')
      error('The original Core identity belongs to a Mote. Its workface and content are retained.', 'TOPIC_TARGET_IS_MOTE')
    const ids = new Set(state ? categoriesFromSpatial(state.graph).map(category => category.spaceId) : [])
    return { zoneId, categorySpaceIds: state?.graph.bindings.filter(binding => binding.zoneId === zoneId && ids.has(binding.spaceId)).map(binding => binding.spaceId) ?? [],
      chatIds: state?.graph.tabs.filter(tab => tab.zoneId === zoneId).map(tab => tab.tabId) ?? [], spatialRevision: state?.revision ?? 0,
      ...(origin && typeof origin === 'object' && !Array.isArray(origin) && origin.contentKind === 'topic' &&
        origin.topicId === topic.id && origin.workspaceId === workspace.id && original.some(zone => zone.zoneId === zoneId)
        ? { contentKind: 'topic' as const } : {}) }
  }
  async ensureCategory(category: TopicCategory): Promise<void> {
    const current = await this.ports.state.read(), graph = structuredClone(current?.graph ?? emptyGraph())
    registerTopicCategory(graph, category)
    if (JSON.stringify(graph) !== JSON.stringify(current?.graph)) await this.ports.state.commit({ expectedRevision: current?.revision ?? 0, graph })
  }
  async ensureTopic(topic: ScratchTopicSnapshot, categoryId?: string): Promise<TopicSpatialInspection> {
    if (!isKnowledgeTopic(topic)) error('This exact content belongs to a Mote. Choose an ordinary Topic.', 'TOPIC_TARGET_IS_MOTE')
    const category = categoryId ? (await this.ports.categories()).find(category => category.categoryId === categoryId) : await this.ports.ensureDefaultCategory()
    if (!category || category.readError) error('The exact Topic Category is unavailable. Original content is retained.', 'TOPIC_CATEGORY_UNAVAILABLE')
    const current = await this.ports.state.read(), graph = structuredClone(current?.graph ?? emptyGraph())
    registerKnowledgeTopic(graph, this.ports.workspace(), topic, category)
    if (JSON.stringify(graph) !== JSON.stringify(current?.graph)) await this.ports.state.commit({ expectedRevision: current?.revision ?? 0, graph, allowEntityRemoval: true })
    return this.inspect(topic)
  }
  async moveTopic(topicId: string, categoryId: string, expectedRevision: number) {
    const [topics, categories, state] = await Promise.all([this.ports.topics(), this.ports.categories(), this.ports.state.read()])
    if ((state?.revision ?? 0) !== expectedRevision) error('Topic membership changed. Inspect the exact Topic and retry with its current revision.', 'SPATIAL_STATE_CONFLICT')
    const topic = topics.find(topic => topic.id === topicId), category = categories.find(category => category.categoryId === categoryId)
    if (!topic || !isKnowledgeTopic(topic)) error('An exact ordinary Topic is required; the existing object is retained.', 'TOPIC_TARGET_UNKNOWN')
    if (topic.readError || !category || category.readError) error('Topic or Category content is unavailable. Its original membership is retained.', 'TOPIC_CONTENT_UNAVAILABLE')
    const zoneId = topicContentZoneId(this.ports.workspace(), topic), graph = structuredClone(state?.graph ?? emptyGraph())
    const categoryIds = new Set([...categories, ...categoriesFromSpatial(graph)].map(category => category.spaceId))
    const previousCategorySpaceIds = graph.bindings.filter(binding => binding.zoneId === zoneId && categoryIds.has(binding.spaceId)).map(binding => binding.spaceId)
    registerKnowledgeTopic(graph, this.ports.workspace(), topic, category)
    graph.bindings = graph.bindings.filter(binding => binding.zoneId !== zoneId || !categoryIds.has(binding.spaceId) || binding.spaceId === category.spaceId)
    const next = await this.ports.state.commit({ expectedRevision, graph, allowEntityRemoval: true })
    return { zoneId, categorySpaceIds: [category.spaceId], chatIds: next.graph.tabs.filter(tab => tab.zoneId === zoneId).map(tab => tab.tabId),
      previousCategorySpaceIds, spatialRevision: next.revision }
  }
  private defaultDescriptor(): TopicCategory {
    const workspace = this.ports.workspace(), directoryPath = join(scratchTopicStorageRoots(workspace.path).topics, 'category--' + UNCLASSIFIED_TOPIC_CATEGORY_ID)
    return { categoryId: UNCLASSIFIED_TOPIC_CATEGORY_ID, title: '未分类', hostId: workspace.hostId,
      spaceId: directoryIdentity(workspace.hostId, directoryPath), directoryPath, revision: null }
  }
  async migratePreview(): Promise<TopicMigrationPreview> {
    const [state, topics, categories] = await Promise.all([this.ports.state.read(), this.ports.topics(), this.ports.categories()])
    const category = categories.find(category => category.categoryId === UNCLASSIFIED_TOPIC_CATEGORY_ID) ?? this.defaultDescriptor()
    const savedCategories = state ? categoriesFromSpatial(state.graph) : []
    const categoryIds = new Set([...savedCategories, ...categories].map(category => category.spaceId)), unavailable: TopicUnavailable[] = []
    const migrating = topics.filter(isKnowledgeTopic).flatMap(topic => {
      if (topic.readError) { unavailable.push({ code: 'TOPIC_CONTENT_UNAVAILABLE', message: topic.readError, recovery: 'Restore this original content before converting it. Its identity and workface are retained.', source: topic.id }); return [] }
      const sourceSpaceId = topicContentSpaceId(this.ports.workspace(), topic), zoneId = topicContentZoneId(this.ports.workspace(), topic)
      // An unreadable object is an observation gap, never permission to reclassify a Mote.
      if (topic.readError || state?.graph.spaces.some(space => space.spaceId === sourceSpaceId && space.kind === 'mote')) {
        unavailable.push({ code: 'TOPIC_CONTENT_UNAVAILABLE', message: topic.readError ?? 'The original object is a Mote.',
          recovery: 'Restore this exact content before converting it; its workface and Runs are retained.', source: topic.id })
        return []
      }
      const bound = state?.graph.bindings.find(binding => binding.zoneId === zoneId && categoryIds.has(binding.spaceId))
      const original = state?.graph.resources['zone:' + zoneId]
      const converted = original && typeof original === 'object' && !Array.isArray(original) && original.topicId === topic.id
      if (bound && !categories.some(category => category.spaceId === bound.spaceId && !category.readError))
        unavailable.push({ code: 'TOPIC_CATEGORY_UNAVAILABLE', message: 'The original Category description is currently unavailable.',
          recovery: 'Restore the original Category. Its confirmed membership and all Topic work remain available.', source: bound.spaceId })
      if (converted && bound && !state?.graph.spaces.some(space => space.spaceId === sourceSpaceId)) return []
      return [{ topicId: topic.id, sourceSpaceId, zoneId, categorySpaceId: bound?.spaceId ?? category.spaceId }]
    })
    if (category.readError) unavailable.push({ code: 'TOPIC_CATEGORY_UNAVAILABLE', message: category.readError,
      recovery: 'Restore the Category description; all original Topic contents remain in place.', source: category.categoryId })
    return { spatialRevision: state?.revision ?? 0, topics: migrating, category,
      required: migrating.length > 0 || !state?.graph.spaces.some(space => space.spaceId === category.spaceId), unavailable }
  }
  async migrateApply(expectedRevision: number): Promise<TopicMigrationReceipt> {
    const preview = await this.migratePreview()
    if (preview.spatialRevision !== expectedRevision) error('Spatial state changed after preview. Read the new revision; the original graph is retained.', 'SPATIAL_STATE_CONFLICT')
    if (preview.unavailable.length) error('Some Topic content is unconfirmed. Restore the reported objects before applying this migration.', 'TOPIC_MIGRATION_UNCONFIRMED')
    if (!preview.required) return { spatialRevision: expectedRevision, backupPath: null, migratedTopicIds: [], diskDurability: 'confirmed' }
    const category = await this.ports.ensureDefaultCategory()
    const [state, topics, categories] = await Promise.all([this.ports.state.read(), this.ports.topics(), this.ports.categories()])
    if ((state?.revision ?? 0) !== expectedRevision) error('Spatial state changed. The created Category content is retained for exact readback; preview again.', 'SPATIAL_STATE_CONFLICT')
    const graph = structuredClone(state?.graph ?? emptyGraph())
    registerTopicCategory(graph, category)
    for (const item of preview.topics) {
      const topic = topics.find(topic => topic.id === item.topicId), destination = categories.find(category => category.spaceId === item.categorySpaceId) ??
        (item.categorySpaceId === category.spaceId ? category : undefined)
      if (!topic || topic.readError || !isKnowledgeTopic(topic) || !destination || destination.readError)
        error('Topic discovery changed after preview. Original graph is retained; preview again.', 'TOPIC_MIGRATION_UNCONFIRMED')
      registerKnowledgeTopic(graph, this.ports.workspace(), topic, destination)
    }
    const backupPath = state ? join(dirname(this.ports.state.path), 'backups', `topic-hierarchy-${expectedRevision}-${randomUUID()}.json`) : null
    if (backupPath) {
      await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 })
      const directory = await lstat(dirname(backupPath))
      if (!directory.isDirectory() || directory.isSymbolicLink()) error('The backup directory is not a confirmed regular directory. Original graph is retained.', 'TOPIC_BACKUP_UNCONFIRMED')
      await durableWriteFile(backupPath, JSON.stringify(state) + '\n', { requireDirectorySync: true })
    }
    const next = await this.ports.state.commit({ expectedRevision, graph, allowEntityRemoval: true })
    return { spatialRevision: next.revision, backupPath, migratedTopicIds: preview.topics.map(topic => topic.topicId), diskDurability: 'confirmed' }
  }
}
