import { createRequire } from 'node:module'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { defaultAgentMuxStateDirectory } from './runtime-paths.js'
import type { AgentMuxSpaceCatalog, AgentMuxSpaceSelector, AgentMuxSpaceBindingTarget } from './space-control.js'
import { addTabOccurrence, removeTab, regionIds, groupIds, regionInDirection, workbenchRegionBounds,
  leafIdsMatchRecords, type WorkspaceLayout, type WorkbenchViewLayout, type SplitDirection } from './spatial-layout.js'

/** Resource metadata is JSON supplied and interpreted by its original host. */
export type SpatialJson = null | boolean | number | string | SpatialJson[] | { [key: string]: SpatialJson }
export type AgentMuxSpatialGraph = Omit<AgentMuxSpaceCatalog, 'locations'> & {
  layouts: Record<string, WorkspaceLayout>
  tabLayouts: Record<string, WorkbenchViewLayout>
  resources: Record<string, SpatialJson>
}
export type AgentMuxSpatialState = {
  schemaVersion: 1
  revision: number
  graph: AgentMuxSpatialGraph
}
export type AgentMuxSpatialCommit = { expectedRevision: number; graph: AgentMuxSpatialGraph; allowEntityRemoval?: boolean }
export type AgentMuxSpatialResolve = { tabId: string; regionId: string; direction: SplitDirection }

function invalid(message: string): never {
  // Reject this malformed write/read, never remove an entity or stop a healthy Run.
  throw new AgentMuxError(message, 'SPATIAL_STATE_INVALID')
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('A spatial object is required.')
  return value as Record<string, unknown>
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) invalid('A stable spatial ID is required.')
}
function nullableId(value: unknown): void { if (value !== null) id(value) }
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) invalid('Spatial IDs must be an array.')
  value.forEach(id)
  if (new Set(value).size !== value.length) invalid('Spatial IDs cannot repeat in one record.')
}
function tree(value: unknown, leaf: 'groupId' | 'regionId', depth = 0): void {
  if (depth > 256) invalid('Spatial topology is too deep.')
  const n = record(value)
  if (n.type === 'leaf') { id(n[leaf]); return }
  if (n.type !== 'split' || !['horizontal', 'vertical'].includes(String(n.direction)) ||
    typeof n.ratio !== 'number' || !Number.isFinite(n.ratio) || n.ratio <= 0 || n.ratio >= 1) invalid('Invalid spatial split.')
  tree(n.first, leaf, depth + 1); tree(n.second, leaf, depth + 1)
}
function json(value: unknown, depth = 0): void {
  if (depth > 256) invalid('Spatial JSON is too deep.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { value.forEach(v => json(v,depth+1)); return }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) { Object.values(value).forEach(v => json(v,depth+1)); return }
  invalid('Spatial metadata must be finite JSON, without undefined or executable values.')
}
function facts(value: unknown, key: string, check: (entry: Record<string, unknown>) => void): void {
  if (!Array.isArray(value)) invalid('Spatial facts must be arrays.')
  const ids = new Set<string>()
  for (const item of value) {
    const entry = record(item); id(entry[key]); const stable = entry[key] as string
    if (ids.has(stable)) invalid('Duplicate spatial identity.'); ids.add(stable); check(entry)
  }
}
/** Validation preserves unknown references; observation gaps never delete facts. */
export function parseAgentMuxSpatialGraph(value: unknown): AgentMuxSpatialGraph {
  const g = record(value)
  facts(g.spaces, 'spaceId', s => { id(s.hostId); id(s.directoryPath); nullableId(s.projectId);
    if (typeof s.name !== 'string' || !['folder','topic','mote','container'].includes(String(s.kind))) invalid('Invalid Space fact.') })
  facts(g.zones, 'zoneId', z => { id(z.workspaceId); nullableId(z.hostId); nullableId(z.directoryPath); nullableId(z.branch);
    if (!['directory','worktree','home','unknown'].includes(String(z.kind))) invalid('Invalid Zone fact.') })
  facts(g.tabs, 'tabId', t => { id(t.workspaceId); nullableId(t.zoneId); strings(t.regionIds);
    if (t.name !== null && typeof t.name !== 'string') invalid('Invalid Tab name.') })
  facts(g.regions, 'regionId', r => { id(r.tabId); nullableId(r.agentSessionId); nullableId(r.runId);
    if (!['agent','terminal','browser','file','git-diff','launcher'].includes(String(r.kind))) invalid('Invalid Region kind.')
    if (r.execution !== null) { const e = record(r.execution); id(e.hostId); id(e.cwd) } })
  if (!Array.isArray(g.bindings)) invalid('Spatial bindings must be an array.')
  const bindings = new Set<string>()
  for (const value of g.bindings) { const b = record(value); id(b.zoneId); id(b.spaceId)
    const key = JSON.stringify([b.zoneId,b.spaceId]); if (bindings.has(key)) invalid('Duplicate spatial binding.'); bindings.add(key) }
  for (const [workspaceId, value] of Object.entries(record(g.layouts))) {
    id(workspaceId); const l = record(value); tree(l.root,'groupId'); id(l.activeGroupId)
    if (!Array.isArray(l.groups)) invalid('Spatial Groups must be an array.')
    const ids: string[] = []
    for (const value of l.groups) { const group = record(value); id(group.id); strings(group.tabOrder); strings(group.recentTabIds); nullableId(group.activeTabId)
      if (group.activeTabId !== null && !group.tabOrder.includes(group.activeTabId as string)) invalid('Selected Tab must belong to its Group.')
      if (group.recentTabIds.some(t => !(group.tabOrder as string[]).includes(t))) invalid('Recent Tabs must belong to their Group.')
      ids.push(group.id) }
    const leaves = groupIds(l.root as WorkspaceLayout['root'])
    if (new Set(ids).size !== ids.length || !leafIdsMatchRecords(leaves,ids) || !ids.includes(l.activeGroupId)) invalid('Group records and topology must agree.')
  }
  const tabs = new Map((g.tabs as AgentMuxSpatialGraph['tabs']).map(t => [t.tabId,t]))
  for (const [tabId,value] of Object.entries(record(g.tabLayouts))) { id(tabId); const l = record(value); tree(l.root,'regionId'); id(l.activeRegionId)
    const leaves = regionIds(l.root as WorkbenchViewLayout['root'])
    if (new Set(leaves).size !== leaves.length || !leaves.includes(l.activeRegionId) || (tabs.has(tabId) && !leafIdsMatchRecords(leaves,tabs.get(tabId)!.regionIds))) invalid('Invalid Region selection or repeated leaf.') }
  json(g)
  record(g.resources)
  const encoded = JSON.stringify(g)
  const decoded = JSON.parse(encoded) as AgentMuxSpatialGraph
  return decoded
}
export function spatialCatalog(graph: AgentMuxSpatialGraph, target: AgentMuxSpaceSelector = {}): AgentMuxSpaceCatalog {
  const locations: AgentMuxSpaceCatalog['locations'] = []
  const tabs = new Map(graph.tabs.map(t => [t.tabId,t]))
  for (const [displayWorkspaceId, layout] of Object.entries(graph.layouts)) for (const group of layout.groups) for (const tabId of group.tabOrder) {
    const t = tabs.get(tabId); if (!t) continue
    const spaces = graph.bindings.filter(b => b.zoneId === t.zoneId).map(b => b.spaceId)
    for (const regionId of t.regionIds) for (const spaceId of spaces.length ? spaces : [null]) locations.push({
      spaceId, zoneId:t.zoneId, workspaceId:t.workspaceId, displayWorkspaceId, groupId:group.id, tabId, regionId })
  }
  const selected = locations.filter(location => Object.entries(target).every(([key,value]) => location[key as keyof typeof location] === value))
  if (!Object.keys(target).length) return { spaces:graph.spaces,zones:graph.zones,tabs:graph.tabs,regions:graph.regions,bindings:graph.bindings,locations }
  const selectedTabs = graph.tabs.filter(t =>
    (!target.tabId || t.tabId === target.tabId) &&
    (!target.regionId || t.regionIds.includes(target.regionId)) &&
    (!target.zoneId || t.zoneId === target.zoneId) &&
    (!target.spaceId || graph.bindings.some(b => b.zoneId === t.zoneId && b.spaceId === target.spaceId)) &&
    (!(target.displayWorkspaceId || target.groupId) || selected.some(l => l.tabId === t.tabId)))
  const zoneIds = new Set(selectedTabs.map(t => t.zoneId))
  if (target.zoneId && !target.tabId && !target.regionId) zoneIds.add(target.zoneId)
  if (target.spaceId && !target.tabId && !target.regionId && !target.zoneId) graph.bindings.filter(b => b.spaceId === target.spaceId).forEach(b => zoneIds.add(b.zoneId))
  const selectedRegions = graph.regions.filter(r => (!target.regionId || r.regionId === target.regionId) && selectedTabs.some(t => t.tabId === r.tabId))
  return { spaces:graph.spaces.filter(s => (!target.spaceId || s.spaceId === target.spaceId) && (s.spaceId === target.spaceId || graph.bindings.some(b => b.spaceId === s.spaceId && zoneIds.has(b.zoneId)))),
    zones:graph.zones.filter(z => zoneIds.has(z.zoneId)), tabs:selectedTabs, regions:selectedRegions,
    bindings:graph.bindings.filter(b => zoneIds.has(b.zoneId) && (!target.spaceId || b.spaceId === target.spaceId)),locations:selected }

}
export function resolveSpatialRegion(graph: AgentMuxSpatialGraph, target: AgentMuxSpatialResolve) {
  const layout = graph.tabLayouts[target.tabId]
  if (!layout || !regionIds(layout.root).includes(target.regionId)) return { region:null,locations:[] }
  const next = regionInDirection(workbenchRegionBounds(layout.root),target.regionId,target.direction)
  return { region:graph.regions.find(r => r.tabId === target.tabId && r.regionId === next) ?? null,
    locations:spatialCatalog(graph).locations.filter(l => l.tabId === target.tabId && l.regionId === next) }
}
export function defaultAgentMuxSpatialStatePath(): string {
  const selected = process.env.AGENTMUX_SPATIAL_STATE_STORE
  if (selected && !isAbsolute(selected)) invalid('AGENTMUX_SPATIAL_STATE_STORE must be absolute.')
  return selected || join(defaultAgentMuxStateDirectory(),'spatial-state.json')
}
const requireNative = createRequire(import.meta.url)
/** A single filesystem owner. Lock inode is never removed, including after process death. */
export class AgentMuxSpatialStateStore {
  constructor(readonly path = defaultAgentMuxSpatialStatePath()) {
    if (!isAbsolute(path)) invalid('Spatial state path must be absolute.')
  }
  async read(): Promise<AgentMuxSpatialState | null> {
    let source: string
    try { source = await readFile(this.path,'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    return this.decode(source)
  }
  private decode(source: string): AgentMuxSpatialState {
    try {
      const d = record(JSON.parse(source)); if (d.schemaVersion !== 1 || !Number.isSafeInteger(d.revision) || (d.revision as number) < 1) invalid('Invalid spatial revision.')
      return { schemaVersion:1,revision:d.revision as number,graph:parseAgentMuxSpatialGraph(d.graph) }
    } catch (error) { throw new AgentMuxError('Spatial state could not be read. Original bytes are retained; repair or explicitly restore the previous document.', 'SPATIAL_STATE_READ_UNCONFIRMED', error instanceof Error ? error.message : String(error)) }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path),{recursive:true,mode:0o700})
    const handle = await open(this.path+'.lock','a+',0o600)
    try {
      const native: { tryLock(fd:number):boolean } = requireNative('fs-native-extensions')
      const deadline = Date.now()+5000
      while (!native.tryLock(handle.fd)) {
        if (Date.now() >= deadline) throw new AgentMuxError('Spatial writer is busy. Original data and Runs are kept; retry this write.', 'SPATIAL_STATE_BUSY')
        await delay(10)
      }
      return await operation()
    } finally { await handle.close() }
  }
  async commit(input: AgentMuxSpatialCommit): Promise<AgentMuxSpatialState> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) invalid('An exact nonnegative expected revision is required.')
    const graph = parseAgentMuxSpatialGraph(input.graph)
    return this.locked(async () => {
      const current = await this.read()
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new AgentMuxError('Spatial state changed. Read the current revision and preserve both edits before retrying.', 'SPATIAL_STATE_CONFLICT')
      if (input.allowEntityRemoval !== true && current) {
        for (const [kind,key] of [['spaces','spaceId'],['zones','zoneId'],['tabs','tabId'],['regions','regionId']] as const) {
          const nextIds = new Set(graph[kind].map(entry => (entry as unknown as Record<string,string>)[key]))
          if (current.graph[kind].some(entry => !nextIds.has((entry as unknown as Record<string,string>)[key]))) {
            throw new AgentMuxError('An entity is missing from this update. Original entities are retained; explicit deletion is required.', 'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED')
          }
        }
      }
      const next: AgentMuxSpatialState = {schemaVersion:1,revision:(current?.revision ?? 0)+1,graph}
      if (current) await durableWriteFile(this.path+'.previous',JSON.stringify(current)+'\n',{requireDirectorySync:true})
      await durableWriteFile(this.path,JSON.stringify(next)+'\n',{requireDirectorySync:true})
      return next
    })
  }
  async bind(binding: AgentMuxSpaceBindingTarget, remove: boolean): Promise<AgentMuxSpatialState> {
    // Optimistic conflict is reported, not silently replayed against a different graph.
    const state = await this.read()
    if (!state) throw new AgentMuxError('No durable spatial graph has been registered.', 'SPATIAL_STATE_ABSENT')
    const graph = structuredClone(state.graph)
    if (binding.kind === 'zone-space') {
      if (!graph.zones.some(z => z.zoneId === binding.zoneId) || !graph.spaces.some(s => s.spaceId === binding.spaceId)) invalid('Binding entities must be known.')
      const exists = graph.bindings.some(b => b.zoneId === binding.zoneId && b.spaceId === binding.spaceId)
      if (remove) graph.bindings = graph.bindings.filter(b => !(b.zoneId === binding.zoneId && b.spaceId === binding.spaceId))
      else if (!exists) graph.bindings.push({zoneId:binding.zoneId,spaceId:binding.spaceId})
    } else {
      const layout = graph.layouts[binding.displayWorkspaceId]
      if (!layout?.groups.some(g => g.id === binding.groupId) || !graph.tabs.some(t => t.tabId === binding.tabId)) invalid('The exact Tab and display Group must be known.')
      const next = remove ? removeTab(layout,binding.groupId,binding.tabId) : addTabOccurrence(layout,binding.groupId,binding.tabId)
      if (next) graph.layouts[binding.displayWorkspaceId] = next
    }
    return this.commit({expectedRevision:state.revision,graph})
  }
}
