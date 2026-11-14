import { isDeepStrictEqual } from 'node:util';
import { AgentMuxError } from './errors.js';
import { rpcRecord } from './rpc-data.js';
import { parseAgentMuxSpatialGraph, type AgentMuxSpatialGraph, type AgentMuxSpatialState } from './spatial-graph.js';
/** IDs inside this reference retain the answering Core's namespace. Routes are client-local carriers. */
export type SpaceAuthorityRef = {
    runtimeId: string;
    spaceId: string;
};
export type SpaceAuthoritySource = {
    runtimeId: string;
    ownerInstanceId: string;
};
export type SpaceScope = {
    space: AgentMuxSpatialGraph['spaces'][number] | null;
    zones: AgentMuxSpatialGraph['zones'];
    tabs: AgentMuxSpatialGraph['tabs'];
    regions: AgentMuxSpatialGraph['regions'];
    bindings: AgentMuxSpatialGraph['bindings'];
};
export type SpaceSnapshot = {
    reference: SpaceAuthorityRef;
    source: SpaceAuthoritySource;
    revision: number;
    scope: SpaceScope;
};
/** Explicit entity edits, never a filtered graph submitted as a complete graph. */
export type SpaceEdits = Partial<Pick<SpaceScope, 'zones' | 'tabs' | 'regions' | 'bindings'>> & {
    remove?: {
        zones?: string[];
        tabs?: string[];
        regions?: string[];
    };
};
export type SpaceApply = {
    reference: SpaceAuthorityRef;
    expectedRevision: number;
    changes: SpaceEdits;
};
export type SpaceCursor = {
    runtimeId: string;
    revision: number;
};
export type SpaceWatch = {
    reference: SpaceAuthorityRef;
    after?: SpaceCursor;
};
export type SpaceWatchOpening = {
    snapshot: SpaceSnapshot;
    gap: {
        requested: SpaceCursor;
        availableRevision: number;
        reason: 'snapshot-required';
    } | null;
};
export type SpaceDelta = SpaceEdits & {
    space?: SpaceScope['space'];
};
export type SpaceChange = {
    reference: SpaceAuthorityRef;
    source: SpaceAuthoritySource;
    fromRevision: number;
    revision: number;
    delta: SpaceDelta;
};
export type SpaceApplyReceipt = {
    reference: SpaceAuthorityRef;
    source: SpaceAuthoritySource;
    revision: number;
    diskDurability: 'confirmed';
};
export const SPACE_AUTHORITY_METHODS = { 'space.snapshot': 'long', 'space.apply': 'long', 'space.watch': 'long' } as const;
export type SpaceAuthorityParams = {
    'space.snapshot': {
        reference: SpaceAuthorityRef;
    };
    'space.apply': SpaceApply;
    'space.watch': SpaceWatch;
};
export type SpaceAuthorityResults = {
    'space.snapshot': never;
    'space.apply': SpaceApplyReceipt;
    'space.watch': never;
};
export const isSpaceAuthorityMethod = (method: unknown): method is keyof typeof SPACE_AUTHORITY_METHODS => typeof method === 'string' && Object.hasOwn(SPACE_AUTHORITY_METHODS, method);
const invalid = (message: string, code = 'INVALID_CONTROL_REQUEST'): never => { throw new AgentMuxError(message, code); };
/** Same opaque identity contract as the original spatial graph; no new path-length/version gate. */
function rpcString(value: unknown, label: string, code = 'INVALID_CONTROL_REQUEST'): string {
    if (typeof value !== 'string' || !value || value.includes('\0'))
        invalid(`${label} requires its exact original identity.`, code);
    return value as string;
}
function count(value: unknown, code: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
        invalid('An exact nonnegative Space revision is required.', code);
    return value as number;
}
export function parseSpaceAuthorityRef(value: unknown, code = 'INVALID_CONTROL_REQUEST'): SpaceAuthorityRef {
    const p = rpcRecord(value, ['runtimeId', 'spaceId'], code);
    return { runtimeId: rpcString(p.runtimeId, 'Original Space Runtime', code), spaceId: rpcString(p.spaceId, 'Original Space', code) };
}
export function parseSpaceAuthorityParams<M extends keyof SpaceAuthorityParams>(method: M, value: unknown): SpaceAuthorityParams[M] {
    const p = rpcRecord(value, method === 'space.apply' ? ['reference', 'expectedRevision', 'changes'] : method === 'space.watch' ? ['reference', 'after'] : ['reference']);
    const reference = parseSpaceAuthorityRef(p.reference);
    if (method === 'space.apply') {
        const changes = rpcRecord(p.changes, ['zones', 'tabs', 'regions', 'bindings', 'remove']);
        for (const key of ['zones', 'tabs', 'regions', 'bindings'])
            if (changes[key] !== undefined && !Array.isArray(changes[key]))
                invalid('Space entity edits must be arrays.');
        if (changes.remove !== undefined) {
            const remove = rpcRecord(changes.remove, ['zones', 'tabs', 'regions']);
            for (const ids of Object.values(remove))
                if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id || id.includes('\0')) || new Set(ids).size !== ids.length)
                    invalid('Exact unique removal IDs are required.');
        }
        return { reference, expectedRevision: count(p.expectedRevision, 'INVALID_CONTROL_REQUEST'), changes } as SpaceAuthorityParams[M];
    }
    if (method === 'space.watch' && p.after !== undefined) {
        const after = rpcRecord(p.after, ['runtimeId', 'revision']);
        return { reference, after: { runtimeId: rpcString(after.runtimeId, 'Original cursor Runtime'), revision: count(after.revision, 'INVALID_CONTROL_REQUEST') } } as SpaceAuthorityParams[M];
    }
    return { reference } as SpaceAuthorityParams[M];
}
const BUSINESS_FIELDS = {
    spaces: ['spaceId', 'kind', 'name', 'hostId', 'directoryPath', 'projectId', 'topicId', 'issue'],
    zones: ['zoneId', 'workspaceId', 'kind', 'hostId', 'directoryPath', 'branch', 'issue'],
    tabs: ['tabId', 'zoneId', 'workspaceId', 'name', 'nameRevision', 'regionIds', 'issue'],
    regions: ['regionId', 'tabId', 'kind', 'browserId', 'file', 'agentSessionId', 'runId', 'execution'],
    bindings: ['zoneId', 'spaceId']
} as const;
/** Opaque host JSON and window details cannot enter the shared business DTO. */
function businessFact<K extends keyof typeof BUSINESS_FIELDS>(kind: K, value: AgentMuxSpatialGraph[K][number]): AgentMuxSpatialGraph[K][number] {
    const record = value as unknown as Record<string, unknown>;
    const result = Object.fromEntries(BUSINESS_FIELDS[kind].filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
    if (kind === 'regions') {
        if (result.execution && typeof result.execution === 'object') {
            const e = result.execution as Record<string, unknown>;
            result.execution = { hostId: e.hostId, cwd: e.cwd };
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
    const after = new SpaceScopeIndex({ ...state, graph }).select(input.reference.spaceId);
    for (const field of ['zones', 'tabs', 'regions'] as const) {
        const key = idKeys[field], ids = new Set(after[field].map(item => String(item[key as keyof typeof item])));
        for (const item of edit[field] ?? [])
            if (!ids.has(String(item[key as keyof typeof item])))
                invalid('Edited entities must remain members of the exact Space.', 'SPACE_PARENT_MISMATCH');
    }
    return parseAgentMuxSpatialGraph(graph);
}
export function parseSpaceSnapshot(value: unknown, reference: SpaceAuthorityRef): SpaceSnapshot {
    const p = rpcRecord(value, ['reference', 'source', 'revision', 'scope'], 'CONTROL_PROTOCOL_ERROR');
    const ref = parseSpaceAuthorityRef(p.reference, 'CONTROL_PROTOCOL_ERROR'), source = rpcRecord(p.source, ['runtimeId', 'ownerInstanceId'], 'CONTROL_PROTOCOL_ERROR');
    if (!isDeepStrictEqual(ref, reference) || source.runtimeId !== ref.runtimeId)
        invalid('The Space observation belongs to another original authority or Space.', 'CONTROL_PROTOCOL_ERROR');
    rpcString(source.ownerInstanceId, 'Space source instance', 'CONTROL_PROTOCOL_ERROR');
    count(p.revision, 'CONTROL_PROTOCOL_ERROR');
    const scope = rpcRecord(p.scope, ['space', 'zones', 'tabs', 'regions', 'bindings'], 'CONTROL_PROTOCOL_ERROR');
    if (scope.space !== null)
        rpcRecord(scope.space, BUSINESS_FIELDS.spaces, 'CONTROL_PROTOCOL_ERROR');
    for (const field of ['zones', 'tabs', 'regions', 'bindings'] as const) {
        if (!Array.isArray(scope[field]))
            invalid('Space members must be typed record arrays.', 'CONTROL_PROTOCOL_ERROR');
        for (const item of scope[field] as unknown[]) {
            const fact = rpcRecord(item, BUSINESS_FIELDS[field], 'CONTROL_PROTOCOL_ERROR');
            if (field === 'regions') {
                if (fact.execution !== null)
                    rpcRecord(fact.execution, ['hostId', 'cwd'], 'CONTROL_PROTOCOL_ERROR');
                if (fact.file !== undefined) {
                    const file = rpcRecord(fact.file, ['workspaceId', 'path', 'zoneRelativePath', 'issue'], 'CONTROL_PROTOCOL_ERROR');
                    rpcString(file.workspaceId, 'Original File Workspace', 'CONTROL_PROTOCOL_ERROR');
                    if (typeof file.path !== 'string')
                        invalid('The original File path is unconfirmed.', 'CONTROL_PROTOCOL_ERROR');
                }
            }
        }
    }
    parseAgentMuxSpatialGraph({ spaces: scope.space === null ? [] : [scope.space], zones: scope.zones, tabs: scope.tabs, regions: scope.regions, bindings: scope.bindings, layouts: {}, tabLayouts: {}, resources: {} });
    if (scope.space !== null && (scope.space as SpaceScope['space'])?.spaceId !== ref.spaceId || (scope.bindings as SpaceScope['bindings']).some(binding => binding.spaceId !== ref.spaceId))
        invalid('The Space projection contains another scope.', 'CONTROL_PROTOCOL_ERROR');
    const zones = new Set((scope.bindings as SpaceScope['bindings']).map(binding => binding.zoneId));
    if ((scope.zones as SpaceScope['zones']).some(zone => !zones.has(zone.zoneId)))
        invalid('A Zone belongs to another original Space.', 'CONTROL_PROTOCOL_ERROR');
    const tabs = new Set((scope.tabs as SpaceScope['tabs']).map(tab => tab.tabId));
    if ((scope.tabs as SpaceScope['tabs']).some(tab => !tab.zoneId || !zones.has(tab.zoneId)) || (scope.regions as SpaceScope['regions']).some(region => !tabs.has(region.tabId)))
        invalid('The Space projection contains foreign members.', 'CONTROL_PROTOCOL_ERROR');
    return value as SpaceSnapshot;
}
/** Apply one ordered source delta; gaps keep the caller's prior snapshot intact. */
export function applySpaceChange(previous: SpaceSnapshot, change: SpaceChange): SpaceSnapshot {
    if (!isDeepStrictEqual(previous.reference, change.reference) || !isDeepStrictEqual(previous.source, change.source) || previous.revision !== change.fromRevision)
        invalid('The Space delta no longer follows this exact snapshot. Retain it and reopen the original Space observation.', 'SPACE_OBSERVATION_GAP');
    const scope = structuredClone(previous.scope), delta = change.delta;
    if (Object.hasOwn(delta, 'space'))
        scope.space = delta.space!;
    for (const field of ['zones', 'tabs', 'regions'] as const) {
        const key = { zones: 'zoneId', tabs: 'tabId', regions: 'regionId' }[field];
        const incoming = delta[field] ?? [], changed = new Set(incoming.map(item => String(item[key as keyof typeof item])));
        const removed = new Set(delta.remove?.[field] ?? []);
        (scope as unknown as Record<string, unknown>)[field] = [...scope[field].filter(item => !removed.has(String(item[key as keyof typeof item])) && !changed.has(String(item[key as keyof typeof item]))), ...incoming].sort((a, b) => String(a[key as keyof typeof a]) < String(b[key as keyof typeof b]) ? -1 : String(a[key as keyof typeof a]) > String(b[key as keyof typeof b]) ? 1 : 0);
    }
    if (delta.bindings)
        scope.bindings = delta.bindings;
    return parseSpaceSnapshot({ reference: change.reference, source: change.source, revision: change.revision, scope }, previous.reference);
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
export function parseSpaceChange(value: unknown, reference: SpaceAuthorityRef): SpaceChange {
    const p = rpcRecord(value, ['reference', 'source', 'fromRevision', 'revision', 'delta'], 'CONTROL_PROTOCOL_ERROR');
    const ref = parseSpaceAuthorityRef(p.reference, 'CONTROL_PROTOCOL_ERROR'), source = rpcRecord(p.source, ['runtimeId', 'ownerInstanceId'], 'CONTROL_PROTOCOL_ERROR');
    if (!isDeepStrictEqual(ref, reference) || source.runtimeId !== ref.runtimeId)
        invalid('The Space delta belongs to another original source.', 'CONTROL_PROTOCOL_ERROR');
    rpcString(source.ownerInstanceId, 'Space delta owner', 'CONTROL_PROTOCOL_ERROR');
    if (count(p.fromRevision, 'CONTROL_PROTOCOL_ERROR') >= count(p.revision, 'CONTROL_PROTOCOL_ERROR'))
        invalid('Space observation must advance its source revision.', 'CONTROL_PROTOCOL_ERROR');
    rpcRecord(p.delta, ['space', 'zones', 'tabs', 'regions', 'bindings', 'remove'], 'CONTROL_PROTOCOL_ERROR');
    return value as SpaceChange;
}
