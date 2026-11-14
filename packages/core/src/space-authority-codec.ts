/** Pure original-Space wire codecs and projection reduction, shared by every client. */
import { AgentMuxError } from './errors.js';
import { rpcRecord } from './rpc-data.js';
import { parseAgentMuxSpatialGraph, type AgentMuxSpatialGraph } from './spatial-graph.js';
import { parseSpaceAuthorityRef, spaceIdentityString as rpcString, type SpaceAuthorityRef, type SpaceAuthoritySource } from './space-reference.js';
export { parseSpaceAuthorityRef, type SpaceAuthorityRef, type SpaceAuthoritySource } from './space-reference.js';
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
function count(value: unknown, code: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
        invalid('An exact nonnegative Space revision is required.', code);
    return value as number;
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
export const BUSINESS_FIELDS = {
    spaces: ['spaceId', 'kind', 'name', 'hostId', 'directoryPath', 'projectId', 'topicId', 'issue'],
    zones: ['zoneId', 'workspaceId', 'kind', 'hostId', 'directoryPath', 'branch', 'issue'],
    tabs: ['tabId', 'zoneId', 'workspaceId', 'name', 'nameRevision', 'regionIds', 'issue'],
    regions: ['regionId', 'tabId', 'kind', 'browserId', 'file', 'agentSessionId', 'creationOperationId', 'association', 'runId', 'execution'],
    bindings: ['zoneId', 'spaceId']
} as const;
export function parseSpaceSnapshot(value: unknown, reference: SpaceAuthorityRef): SpaceSnapshot {
    const p = rpcRecord(value, ['reference', 'source', 'revision', 'scope'], 'CONTROL_PROTOCOL_ERROR');
    const ref = parseSpaceAuthorityRef(p.reference, 'CONTROL_PROTOCOL_ERROR'), source = rpcRecord(p.source, ['runtimeId', 'ownerInstanceId'], 'CONTROL_PROTOCOL_ERROR');
    if (ref.runtimeId !== reference.runtimeId || ref.spaceId !== reference.spaceId || source.runtimeId !== ref.runtimeId)
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
                    rpcRecord(fact.execution, ['hostId', 'cwd', 'runtimeId'], 'CONTROL_PROTOCOL_ERROR');
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
    if (previous.reference.runtimeId !== change.reference.runtimeId || previous.reference.spaceId !== change.reference.spaceId ||
        previous.source.runtimeId !== change.source.runtimeId || previous.source.ownerInstanceId !== change.source.ownerInstanceId || previous.revision !== change.fromRevision)
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
export function parseSpaceChange(value: unknown, reference: SpaceAuthorityRef): SpaceChange {
    const p = rpcRecord(value, ['reference', 'source', 'fromRevision', 'revision', 'delta'], 'CONTROL_PROTOCOL_ERROR');
    const ref = parseSpaceAuthorityRef(p.reference, 'CONTROL_PROTOCOL_ERROR'), source = rpcRecord(p.source, ['runtimeId', 'ownerInstanceId'], 'CONTROL_PROTOCOL_ERROR');
    if (ref.runtimeId !== reference.runtimeId || ref.spaceId !== reference.spaceId || source.runtimeId !== ref.runtimeId)
        invalid('The Space delta belongs to another original source.', 'CONTROL_PROTOCOL_ERROR');
    rpcString(source.ownerInstanceId, 'Space delta owner', 'CONTROL_PROTOCOL_ERROR');
    if (count(p.fromRevision, 'CONTROL_PROTOCOL_ERROR') >= count(p.revision, 'CONTROL_PROTOCOL_ERROR'))
        invalid('Space observation must advance its source revision.', 'CONTROL_PROTOCOL_ERROR');
    rpcRecord(p.delta, ['space', 'zones', 'tabs', 'regions', 'bindings', 'remove'], 'CONTROL_PROTOCOL_ERROR');
    return value as SpaceChange;
}
