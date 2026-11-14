import { isDeepStrictEqual } from 'node:util';
import { AgentMuxError } from './errors.js';
import { rpcRecord } from './rpc-data.js';
import { parseAgentMuxSpatialGraph, type AgentMuxSpatialGraph, type AgentMuxSpatialState } from './spatial-graph.js';
import { closeWorkbenchRegion, removeTab } from './spatial-layout.js';
import { BUSINESS_FIELDS, type SpaceScope, type SpaceApply, type SpaceDelta, type SpaceEdits } from './space-authority-codec.js';
export * from './space-authority-codec.js';
const invalid = (message: string, code = 'INVALID_CONTROL_REQUEST'): never => { throw new AgentMuxError(message, code); };
/** Opaque host JSON and window details cannot enter the shared business DTO. */
function businessFact<K extends keyof typeof BUSINESS_FIELDS>(kind: K, value: AgentMuxSpatialGraph[K][number]): AgentMuxSpatialGraph[K][number] {
    const record = value as unknown as Record<string, unknown>;
    const result = Object.fromEntries(BUSINESS_FIELDS[kind].filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
    if (kind === 'regions') {
        if (result.execution && typeof result.execution === 'object') {
            const e = result.execution as Record<string, unknown>;
            result.execution = { hostId: e.hostId, cwd: e.cwd, ...(e.runtimeId === undefined ? {} : { runtimeId: e.runtimeId }) };
        }
        if (result.file && typeof result.file === 'object') {
            const file = result.file as Record<string, unknown>;
            result.file = Object.fromEntries(['workspaceId', 'path', 'zoneRelativePath', 'issue'].filter(key => Object.hasOwn(file, key)).map(key => [key, file[key]]));
        }
    }
    return result as AgentMuxSpatialGraph[K][number];
}
/** One index per observed source graph; selecting a Space only traverses its original members. */
export class SpaceScopeIndex {
    private readonly spaces: Map<string, SpaceScope['space']>;
    private readonly tabFacts = new Map<string, SpaceScope['tabs'][number]>();
    private readonly regionFacts = new Map<string, SpaceScope['regions'][number]>();
    private readonly spacesByZone = new Map<string, Set<string>>();
    private readonly zones = new Map<string, SpaceScope['zones'][number]>();
    private readonly bindings = new Map<string, SpaceScope['bindings']>();
    private readonly tabs = new Map<string, SpaceScope['tabs']>();
    private readonly regions = new Map<string, SpaceScope['regions']>();
    constructor(readonly state: AgentMuxSpatialState) {
        const g = state.graph;
        this.spaces = new Map(g.spaces.map(space => [space.spaceId, businessFact('spaces', space)]));
        for (const original of g.zones) {
            const zone = businessFact('zones', original);
            this.zones.set(zone.zoneId, zone);
        }
        for (const original of g.bindings) {
            const binding = businessFact('bindings', original);
            const owners = this.spacesByZone.get(binding.zoneId) ?? new Set<string>();
            owners.add(binding.spaceId);
            this.spacesByZone.set(binding.zoneId, owners);
            const list = this.bindings.get(binding.spaceId) ?? [];
            list.push(binding);
            this.bindings.set(binding.spaceId, list);
        }
        for (const original of g.tabs) {
            const tab = businessFact('tabs', original);
            this.tabFacts.set(tab.tabId, tab);
            const list = this.tabs.get(tab.zoneId ?? '') ?? [];
            list.push(tab);
            this.tabs.set(tab.zoneId ?? '', list);
        }
        for (const original of g.regions) {
            const region = businessFact('regions', original);
            this.regionFacts.set(region.regionId, region);
            const list = this.regions.get(region.tabId) ?? [];
            list.push(region);
            this.regions.set(region.tabId, list);
        }
    }
    /** Identify affected source scopes once, before per-reader projection or cloning. */
    affected(previous: SpaceScopeIndex): Set<string> {
        const affected = new Set<string>();
        const zone = (index: SpaceScopeIndex, id: string | null | undefined) => {
            if (id)
                for (const space of index.spacesByZone.get(id) ?? [])
                    affected.add(space);
        };
        const tab = (index: SpaceScopeIndex, id: string) => zone(index, index.tabFacts.get(id)?.zoneId);
        const changed = <T>(before: ReadonlyMap<string, T>, after: ReadonlyMap<string, T>, observe: (id: string) => void) => {
            for (const id of new Set([...before.keys(), ...after.keys()]))
                if (!isDeepStrictEqual(before.get(id), after.get(id)))
                    observe(id);
        };
        changed(previous.spaces, this.spaces, id => affected.add(id));
        changed(previous.bindings, this.bindings, id => affected.add(id));
        changed(previous.zones, this.zones, id => { zone(previous, id); zone(this, id); });
        changed(previous.tabFacts, this.tabFacts, id => { tab(previous, id); tab(this, id); });
        changed(previous.regionFacts, this.regionFacts, id => {
            const a = previous.regionFacts.get(id), b = this.regionFacts.get(id);
            if (a)
                tab(previous, a.tabId);
            if (b)
                tab(this, b.tabId);
        });
        return affected;
    }
    select(spaceId: string): SpaceScope {
        const space = this.spaces.get(spaceId) ?? null;
        const bindings = this.bindings.get(spaceId) ?? [];
        const zones = bindings.flatMap(binding => this.zones.get(binding.zoneId) ?? []).sort((a, b) => a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0);
        const tabs = zones.flatMap(zone => this.tabs.get(zone.zoneId) ?? []).sort((a, b) => a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0);
        const regions = tabs.flatMap(tab => this.regions.get(tab.tabId) ?? []).sort((a, b) => a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0);
        return { space, zones, tabs, regions, bindings };
    }
}
export function applySpaceEdits(state: AgentMuxSpatialState, input: SpaceApply): AgentMuxSpatialGraph {
    if (state.revision !== input.expectedRevision)
        invalid('The original Space source changed. Retain both edits and reread its exact revision.', 'SPATIAL_STATE_CONFLICT');
    const before = new SpaceScopeIndex(state).select(input.reference.spaceId);
    if (!before.space)
        invalid('The exact original Space is not present on this authority.', 'SPACE_TARGET_UNKNOWN');
    const graph = structuredClone(state.graph), edit = input.changes, remove = edit.remove ?? {};
    const idKeys = { zones: 'zoneId', tabs: 'tabId', regions: 'regionId' } as const;
    for (const field of ['zones', 'tabs', 'regions'] as const) {
        const key = idKeys[field], incoming = edit[field] ?? [], ids = new Set(before[field].map(item => String(item[key as keyof typeof item])));
        const original = new Map(state.graph[field].map(item => [String(item[key as keyof typeof item]), item]));
        for (const item of incoming) {
            rpcRecord(item, BUSINESS_FIELDS[field]);
            const id = String(item[key as keyof typeof item]);
            if (original.has(id) && !ids.has(id) && !isDeepStrictEqual(businessFact(field, original.get(id)!), item))
                invalid('This edit targets an entity outside the original Space.', 'SPACE_PARENT_MISMATCH');
        }
        for (const id of remove[field] ?? [])
            if (!ids.has(id))
                invalid('Removal targets an entity outside the original Space.', 'SPACE_PARENT_MISMATCH');
        const incomingMap = new Map(incoming.map(item => {
            const id = String(item[key as keyof typeof item]), old = original.get(id);
            const unknown = old ? Object.fromEntries(Object.entries(old).filter(([name]) => !(BUSINESS_FIELDS[field] as readonly string[]).includes(name))) : {};
            return [id, { ...unknown, ...item }];
        }));
        if (incomingMap.size !== incoming.length)
            invalid('Space edit IDs cannot repeat.');
        const removed = new Set(remove[field] ?? []);
        (graph as unknown as Record<string, unknown>)[field] = [...graph[field].filter(item => !removed.has(String(item[key as keyof typeof item])) && !incomingMap.has(String(item[key as keyof typeof item]))), ...incomingMap.values()];
    }
    if (edit.bindings) {
        if (edit.bindings.some(binding => { rpcRecord(binding, BUSINESS_FIELDS.bindings); return binding.spaceId !== input.reference.spaceId; }))
            invalid('Binding changes must name only the original Space.', 'SPACE_PARENT_MISMATCH');
        graph.bindings = [...graph.bindings.filter(binding => binding.spaceId !== input.reference.spaceId), ...edit.bindings];
    }
    for (const id of remove.zones ?? [])
        if (graph.bindings.some(binding => binding.zoneId === id))
            invalid('Unbind the original Zone before removing it; other Space bindings are retained.', 'SPACE_PARENT_MISMATCH');
    // Entity removal also retires its exact saved presentation. Leaving old leaves
    // behind either rejects a valid split close or resurrects it after restart.
    for (const id of remove.regions ?? []) {
        const tabId = state.graph.regions.find(region => region.regionId === id)?.tabId;
        const layout = tabId && graph.tabLayouts[tabId];
        if (!tabId || !layout) continue;
        const next = closeWorkbenchRegion(layout, id);
        if (next) graph.tabLayouts[tabId] = next;
        else delete graph.tabLayouts[tabId];
    }
    for (const id of remove.tabs ?? []) {
        delete graph.tabLayouts[id];
        for (const [workspaceId, layout] of Object.entries(graph.layouts))
            for (const group of layout.groups)
                if (group.tabOrder.includes(id)) graph.layouts[workspaceId] = removeTab(graph.layouts[workspaceId]!, group.id, id);
    }
    const after = new SpaceScopeIndex({ ...state, graph }).select(input.reference.spaceId);
    for (const field of ['zones', 'tabs', 'regions'] as const) {
        const key = idKeys[field], ids = new Set(after[field].map(item => String(item[key as keyof typeof item])));
        for (const item of edit[field] ?? [])
            if (!ids.has(String(item[key as keyof typeof item])))
                invalid('Edited entities must remain members of the exact Space.', 'SPACE_PARENT_MISMATCH');
    }
    return parseAgentMuxSpatialGraph(graph);
}
export function spaceScopeDelta(before: SpaceScope, after: SpaceScope): SpaceDelta {
    const delta: SpaceDelta = {}, remove: NonNullable<SpaceEdits['remove']> = {};
    if (!isDeepStrictEqual(before.space, after.space))
        delta.space = after.space;
    for (const field of ['zones', 'tabs', 'regions'] as const) {
        const key = { zones: 'zoneId', tabs: 'tabId', regions: 'regionId' }[field];
        const previous = new Map(before[field].map(item => [String(item[key as keyof typeof item]), item]));
        const current = new Map(after[field].map(item => [String(item[key as keyof typeof item]), item]));
        const changed = after[field].filter(item => !isDeepStrictEqual(previous.get(String(item[key as keyof typeof item])), item));
        if (changed.length)
            (delta as Record<string, unknown>)[field] = changed;
        const removed = [...previous.keys()].filter(id => !current.has(id));
        if (removed.length)
            remove[field] = removed;
    }
    for (const field of ['bindings'] as const)
        if (!isDeepStrictEqual(before[field], after[field]))
            (delta as Record<string, unknown>)[field] = after[field];
    if (Object.keys(remove).length)
        delta.remove = remove;
    return delta;
}
