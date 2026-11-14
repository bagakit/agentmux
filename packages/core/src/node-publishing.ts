import { AgentMuxError } from './errors.js';
import { rpcCount, rpcRecord, rpcString } from './rpc-data.js';
/** This Core's publication; routes and existing full-owner capabilities stay independent. */
export type NodePublishingPolicy = {
    alias: string;
    shareResources: boolean;
    allowedPaths: string[];
    deniedPaths: string[];
    defaultPath: string | null;
};
export type NodeIdentity = {
    runtimeId: string;
    ownerInstanceId: string;
    alias: string;
};
export type NodeRootReference = {
    runtimeId: string;
    rootId: string;
    policyRevision: string;
};
export type NodePublishedRoot = {
    root: NodeRootReference;
    label: string;
};
export type NodeLanding = {
    root: NodeRootReference;
    path: string;
};
export type NodePublication = {
    node: NodeIdentity;
    policyRevision: string;
    resourcesShared: boolean;
    roots: NodePublishedRoot[];
    landing: NodeLanding | null;
};
export type NodePolicyOperation = {
    operationId: string;
    expectedRevision: string;
    revision: string;
    status: 'confirmed' | 'unknown';
    updatedAt: number;
    cause?: {
        code: string;
        message: string;
    };
};
export type NodeSettings = {
    node: NodeIdentity;
    policyRevision: string;
    policy: NodePublishingPolicy;
    /** After this unique owner settles accepted saves, null for a requested ID means no record was found and current policy does not name it. This is not a success receipt. */
    operation: NodePolicyOperation | null;
};
export type NodeMetric<T> = {
    state: 'available';
    value: T;
} | {
    state: 'unavailable';
    code: string;
    message: string;
};
export type NodeCpuCounters = {
    logicalCpus: number;
    userMs: number;
    niceMs: number;
    systemMs: number;
    idleMs: number;
    irqMs: number;
    loadAverage: [
        number,
        number,
        number
    ];
};
/** Counters are cumulative. A consumer needs two compatible samples for interval CPU. */
export type NodeResourceSample = {
    node: NodeIdentity;
    policyRevision: string;
    processId: number;
    observedAt: number;
    /** Cumulative operations of this Core process; never transfer bytes or child-process work. */
    filesystemIo?: NodeMetric<{
        scope: 'filesystem' | 'process-io';
        readOperations: number;
        writeOperations: number;
    }>;
    system: NodeMetric<{
        platform: string;
        architecture: string;
        uptimeSeconds: number;
    }>;
    cpu: NodeMetric<NodeCpuCounters>;
    memory: NodeMetric<{
        totalBytes: number;
        freeBytes: number;
    }>;
    filesystem: NodeMetric<{
        root: NodeRootReference | null;
        totalBytes: number;
        availableBytes: number;
    }>;
    process: NodeMetric<{
        cpuUserMicros: number;
        cpuSystemMicros: number;
        rssBytes: number;
        heapUsedBytes: number;
        heapTotalBytes: number;
        externalBytes: number;
        uptimeSeconds: number;
    }>;
};
export type NodeResources = {
    node: NodeIdentity;
    policyRevision: string;
    status: 'available';
    sample: NodeResourceSample;
} | {
    node: NodeIdentity;
    policyRevision: string;
    status: 'withheld';
} | {
    node: NodeIdentity;
    policyRevision: string;
    status: 'unavailable';
    code: string;
    message: string;
};
export type NodeDirectoryEntry = {
    name: string;
    kind: 'file' | 'directory' | 'link' | 'other';
};
export type NodeFileList = {
    root: NodeRootReference;
    path: string;
    entries: NodeDirectoryEntry[];
    truncated: boolean;
    offset: number;
    nextOffset: number | null;
    revision: string;
};
export type NodeFileRead = {
    root: NodeRootReference;
    path: string;
    encoding: 'base64';
    data: string;
    totalBytes: number;
    offset: number;
    nextOffset: number | null;
    revision: string;
};
export type NodeRoute = {
    hostId: string;
    expectedRuntimeId?: string;
};
export type NodeFileTarget = NodeRoute & {
    root: NodeRootReference;
    path: string;
};
export const NODE_PUBLISHING_METHODS = {
    'settings.node.inspect': 'short', 'settings.node.configure': 'long', 'settings.node.resources': 'long',
    'node.inspect': 'short', 'node.resources': 'long', 'node.files.list': 'long', 'node.files.read': 'long', 'node.resolve': 'short'
} as const;
export type NodePublishingMethod = keyof typeof NODE_PUBLISHING_METHODS;
/** A saved client route qualified by the original semantic Runtime. */
export type NodeOwnerTarget = { hostId: string; expectedRuntimeId: string };
export function parseNodeOwnerTarget(value: unknown): NodeOwnerTarget {
    const p = rpcRecord(value, ['hostId', 'expectedRuntimeId']);
    return { hostId: rpcString(p.hostId, 'Exact saved Node Host'), expectedRuntimeId: rpcString(p.expectedRuntimeId, 'Expected original Node Runtime') };
}
export type NodePublishingParams = {
    'settings.node.inspect': {
        target?: NodeOwnerTarget;
        operationId?: string;
    };
    'settings.node.configure': {
        target?: NodeOwnerTarget;
        expectedRevision: string;
        operationId: string;
        policy: NodePublishingPolicy;
    };
    'settings.node.resources': Record<string, never>;
    'node.inspect': NodeRoute;
    'node.resources': NodeRoute;
    'node.files.list': NodeFileTarget & {
        offset?: number;
        limit?: number;
        expectedRevision?: string;
    };
    'node.files.read': NodeFileTarget & {
        offset?: number;
        maxBytes?: number;
        expectedRevision?: string;
    };
    'node.resolve': NodeRoute & {
        alias?: string;
    };
};
export type NodePublishingResults = {
    'settings.node.inspect': NodeSettings;
    'settings.node.configure': NodeSettings;
    'settings.node.resources': NodeResources;
    'node.inspect': NodePublication;
    'node.resources': NodeResources;
    'node.files.list': NodeFileList;
    'node.files.read': NodeFileRead;
    'node.resolve': NodePublication;
};
export type NodePublishingPort = {
    call<M extends NodePublishingMethod>(method: M, input: NodePublishingParams[M], signal?: AbortSignal): Promise<NodePublishingResults[M]>;
};
export function isNodePublishingMethod(value: unknown): value is NodePublishingMethod { return typeof value === 'string' && Object.hasOwn(NODE_PUBLISHING_METHODS, value); }
const failure = (message: string, code = 'INVALID_CONTROL_REQUEST'): never => { throw new AgentMuxError(message, code); };
export function nodeAlias(value: unknown): string {
    if (typeof value !== 'string' || value !== '' && (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value) || value.length > 63))
        failure('Use an empty alias or a lowercase DNS label of at most 63 characters.');
    return value as string;
}
export function parseNodePublishingPolicy(value: unknown): NodePublishingPolicy {
    const p = rpcRecord(value, ['alias', 'shareResources', 'allowedPaths', 'deniedPaths', 'defaultPath']);
    if (typeof p.shareResources !== 'boolean')
        failure('Resource publication must be boolean.');
    const paths = (value: unknown): string[] => {
        if (!Array.isArray(value))
            failure('Node paths must be an array.');
        const result = (value as unknown[]).map(v => { if (typeof v !== 'string' || !v.startsWith('/') || v.includes('\0'))
            failure('Node policy paths must be literal absolute paths.'); return v as string; });
        if (new Set(result).size !== result.length)
            failure('Node paths must be distinct.');
        return result;
    };
    if (p.defaultPath !== null && (typeof p.defaultPath !== 'string' || !p.defaultPath.startsWith('/') || p.defaultPath.includes('\0')))
        failure('The default path must be null or a literal absolute path.');
    return { alias: nodeAlias(p.alias), shareResources: p.shareResources as boolean, allowedPaths: paths(p.allowedPaths), deniedPaths: paths(p.deniedPaths), defaultPath: p.defaultPath as string | null };
}
export function parseNodeRootReference(value: unknown): NodeRootReference {
    const p = rpcRecord(value, ['runtimeId', 'rootId', 'policyRevision']);
    return { runtimeId: rpcString(p.runtimeId, 'Original Node Runtime'), rootId: rpcString(p.rootId, 'Published root'), policyRevision: rpcString(p.policyRevision, 'Published policy revision') };
}
export function nodeRelativePath(value: unknown): string {
    if (typeof value !== 'string' || value.startsWith('/') || value.includes('\0') || value.split('/').some(p => p === '..' || p === '.'))
        failure('Use a literal relative path inside the published root.');
    return value as string;
}
export function parseNodePublishingParams<M extends NodePublishingMethod>(method: M, value: unknown): NodePublishingParams[M] {
    if (method === 'settings.node.inspect') {
        const p = rpcRecord(value, ['operationId', 'target']);
        return { ...(p.operationId === undefined ? {} : { operationId: rpcString(p.operationId, 'Original policy operation') }),
            ...(p.target === undefined ? {} : { target: parseNodeOwnerTarget(p.target) }) } as NodePublishingParams[M];
    }
    if (method === 'settings.node.configure') {
        const p = rpcRecord(value, ['expectedRevision', 'operationId', 'policy', 'target']);
        return { expectedRevision: rpcString(p.expectedRevision, 'Expected policy revision'), operationId: rpcString(p.operationId, 'Original policy operation'), policy: parseNodePublishingPolicy(p.policy),
            ...(p.target === undefined ? {} : { target: parseNodeOwnerTarget(p.target) }) } as NodePublishingParams[M];
    }
    if (method === 'settings.node.resources') {
        rpcRecord(value, []);
        return {} as NodePublishingParams[M];
    }
    const p = rpcRecord(value, ['hostId', 'expectedRuntimeId', ...(method === 'node.resolve' ? ['alias'] : []), ...(method.startsWith('node.files.') ? ['root', 'path', ...(method === 'node.files.list' ? ['offset', 'limit', 'expectedRevision'] : ['offset', 'maxBytes', 'expectedRevision'])] : [])]);
    const result: Record<string, unknown> = { hostId: rpcString(p.hostId, 'Exact Node route') };
    if (p.expectedRuntimeId !== undefined)
        result.expectedRuntimeId = rpcString(p.expectedRuntimeId, 'Expected original Node Runtime');
    if (method === 'node.resolve' && p.alias !== undefined)
        result.alias = nodeAlias(p.alias);
    if (method.startsWith('node.files.')) {
        result.root = parseNodeRootReference(p.root);
        result.path = nodeRelativePath(p.path);
    }
    for (const [key, maximum] of [['limit', 1000], ['maxBytes', 64 * 1024], ['offset', Number.MAX_SAFE_INTEGER]] as const)
        if (p[key] !== undefined) {
            const n = rpcCount(p[key], 0, maximum);
            if (key !== 'offset' && n < 1)
                failure('A Node read budget must be positive.');
            result[key] = n;
        }
    if (p.expectedRevision !== undefined)
        result.expectedRevision = rpcString(p.expectedRevision, 'Original file revision');
    return result as NodePublishingParams[M];
}
/** Strict wire result decoding; producer identity and policy never come from display labels. */
export function parseNodePublishingResult<M extends NodePublishingMethod>(method: M, value: unknown, input: NodePublishingParams[M]): NodePublishingResults[M] {
    const code = 'CONTROL_PROTOCOL_ERROR';
    const fail = (): never => failure('Node publication returned malformed or different original facts.', code);
    const rec = (v: unknown, keys: string[]) => rpcRecord(v, keys, code);
    const text = (v: unknown): string => typeof v === 'string' && v.length > 0 && !v.includes('\0') ? v : fail();
    const count = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail();
    const identity = (v: unknown): NodeIdentity => { const n = rec(v, ['runtimeId', 'ownerInstanceId', 'alias']); if (typeof n.alias !== 'string' || n.alias !== '' && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(n.alias) || String(n.alias).length > 63)
        fail(); return { runtimeId: text(n.runtimeId), ownerInstanceId: text(n.ownerInstanceId), alias: n.alias as string }; };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const route = input as NodeRoute;
    const root = (v: unknown): NodeRootReference => { const r = rec(v, ['runtimeId', 'rootId', 'policyRevision']); return { runtimeId: text(r.runtimeId), rootId: text(r.rootId), policyRevision: text(r.policyRevision) }; };
    const metric = <T>(v: unknown, parse: (p: Record<string, unknown>) => T, keys: string[]): NodeMetric<T> => {
        const m = rec(v, ['state', 'value', 'code', 'message']);
        if (m.state === 'unavailable' && m.value === undefined)
            return { state: 'unavailable', code: text(m.code), message: text(m.message) };
        if (m.state !== 'available' || m.code !== undefined || m.message !== undefined)
            fail();
        return { state: 'available', value: parse(rec(m.value, keys)) };
    };
    if (method.startsWith('settings.node.') && method !== 'settings.node.resources') {
        const p = rec(value, ['node', 'policyRevision', 'policy', 'operation']), node = identity(p.node), revision = text(p.policyRevision);
        let policy: NodePublishingPolicy;
        try {
            policy = parseNodePublishingPolicy(p.policy);
        }
        catch {
            return fail();
        }
        if (node.alias !== policy.alias)
            fail();
        let operation: NodePolicyOperation | null = null;
        if (p.operation !== null) {
            const op = rec(p.operation, ['operationId', 'expectedRevision', 'revision', 'status', 'updatedAt', 'cause']);
            if (!['confirmed', 'unknown'].includes(String(op.status)))
                fail();
            operation = { operationId: text(op.operationId), expectedRevision: text(op.expectedRevision), revision: text(op.revision), status: op.status as NodePolicyOperation['status'], updatedAt: count(op.updatedAt), ...(op.cause === undefined ? {} : (() => { const c = rec(op.cause, ['code', 'message']); return { cause: { code: text(c.code), message: text(c.message) } }; })()) };
        }
        const expected = input as NodePublishingParams['settings.node.inspect'] & Partial<NodePublishingParams['settings.node.configure']>;
        if (expected.target && node.runtimeId !== expected.target.expectedRuntimeId) fail();
        if (expected.operationId !== undefined && operation && operation.operationId !== expected.operationId)
            fail();
        if (method === 'settings.node.configure' && (!operation || operation.operationId !== expected.operationId))
            fail();
        return { node, policyRevision: revision, policy, operation } as NodePublishingResults[M];
    }
    if (method === 'node.files.list' || method === 'node.files.read') {
        const p = rec(value, method === 'node.files.list' ? ['root', 'path', 'entries', 'truncated', 'offset', 'nextOffset', 'revision'] : ['root', 'path', 'encoding', 'data', 'totalBytes', 'offset', 'nextOffset', 'revision']);
        const target = input as NodeFileTarget, originalRoot = root(p.root);
        if (!same(originalRoot, target.root) || p.path !== target.path || (route.expectedRuntimeId !== undefined && originalRoot.runtimeId !== route.expectedRuntimeId))
            fail();
        const offset = count(p.offset), nextOffset = p.nextOffset === null ? null : count(p.nextOffset), revision = text(p.revision);
        if ((input as NodePublishingParams['node.files.read']).expectedRevision !== undefined && revision !== (input as NodePublishingParams['node.files.read']).expectedRevision)
            fail();
        if (!Number.isSafeInteger(offset) || nextOffset !== null && (!Number.isSafeInteger(nextOffset) || nextOffset <= offset))
            fail();
        if (method === 'node.files.list') {
            if (!Array.isArray(p.entries) || typeof p.truncated !== 'boolean' || p.truncated !== (nextOffset !== null) || offset !== ((input as NodePublishingParams['node.files.list']).offset ?? 0))
                fail();
            const entries = (p.entries as unknown[]).map(v => { const e = rec(v, ['name', 'kind']); if (!['file', 'directory', 'link', 'other'].includes(String(e.kind)) || !text(e.name) || String(e.name).includes('/') || ['.', '..'].includes(String(e.name)))
                fail(); return { name: e.name as string, kind: e.kind as NodeDirectoryEntry['kind'] }; });
            if (entries.length > ((input as NodePublishingParams['node.files.list']).limit ?? 100) || new Set(entries.map(e => e.name)).size !== entries.length || nextOffset !== null && nextOffset !== offset + entries.length)
                fail();
            return { root: originalRoot, path: target.path, entries, truncated: p.truncated, offset, nextOffset, revision } as NodePublishingResults[M];
        }
        if (p.encoding !== 'base64' || typeof p.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(p.data))
            fail();
        const data = p.data as string;
        const totalBytes = count(p.totalBytes), requested = input as NodePublishingParams['node.files.read'];
        const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
        if (offset !== (requested.offset ?? 0) || !Number.isSafeInteger(totalBytes) || offset > totalBytes || bytes > (requested.maxBytes ?? 64 * 1024) || offset + bytes > totalBytes || nextOffset !== (offset + bytes < totalBytes ? offset + bytes : null))
            fail();
        return { root: originalRoot, path: target.path, encoding: 'base64', data, totalBytes, offset, nextOffset, revision } as NodePublishingResults[M];
    }
    const isResources = method === 'node.resources' || method === 'settings.node.resources';
    const p = rec(value, isResources ? ['node', 'policyRevision', 'status', 'sample', 'code', 'message'] : ['node', 'policyRevision', 'resourcesShared', 'roots', 'landing']);
    const node = identity(p.node), policyRevision = text(p.policyRevision);
    if (route.expectedRuntimeId !== undefined && node.runtimeId !== route.expectedRuntimeId)
        fail();
    if (isResources) {
        if (p.status === 'withheld' && p.sample === undefined && p.code === undefined && p.message === undefined)
            return { node, policyRevision, status: 'withheld' } as NodePublishingResults[M];
        if (p.status === 'unavailable' && p.sample === undefined)
            return { node, policyRevision, status: 'unavailable', code: text(p.code), message: text(p.message) } as NodePublishingResults[M];
        if (p.status !== 'available' || p.code !== undefined || p.message !== undefined)
            fail();
        const v = rec(p.sample, ['node', 'policyRevision', 'processId', 'observedAt', 'system', 'cpu', 'memory', 'filesystem', 'process', 'filesystemIo']);
        if (!same(identity(v.node), node) || v.policyRevision !== policyRevision || !Number.isSafeInteger(v.processId) || count(v.processId) < 1)
            fail();
        const sample: NodeResourceSample = { node, policyRevision, processId: v.processId as number, observedAt: count(v.observedAt),
            ...(v.filesystemIo === undefined ? {} : { filesystemIo: metric(v.filesystemIo, p => {
                if (p.scope !== 'filesystem' && p.scope !== 'process-io' || !Number.isSafeInteger(p.readOperations) || !Number.isSafeInteger(p.writeOperations)) fail();
                return { scope: p.scope as 'filesystem' | 'process-io', readOperations: count(p.readOperations), writeOperations: count(p.writeOperations) };
            }, ['scope', 'readOperations', 'writeOperations']) }),
            system: metric(v.system, p => ({ platform: text(p.platform), architecture: text(p.architecture), uptimeSeconds: count(p.uptimeSeconds) }), ['platform', 'architecture', 'uptimeSeconds']),
            cpu: metric(v.cpu, p => { if (!Array.isArray(p.loadAverage) || p.loadAverage.length !== 3 || !Number.isSafeInteger(p.logicalCpus) || count(p.logicalCpus) < 1)
                fail(); return { logicalCpus: p.logicalCpus as number, userMs: count(p.userMs), niceMs: count(p.niceMs), systemMs: count(p.systemMs), idleMs: count(p.idleMs), irqMs: count(p.irqMs), loadAverage: (p.loadAverage as unknown[]).map(count) as [
                    number,
                    number,
                    number
                ] }; }, ['logicalCpus', 'userMs', 'niceMs', 'systemMs', 'idleMs', 'irqMs', 'loadAverage']),
            memory: metric(v.memory, p => { const totalBytes = count(p.totalBytes), freeBytes = count(p.freeBytes); if (freeBytes > totalBytes)
                fail(); return { totalBytes, freeBytes }; }, ['totalBytes', 'freeBytes']),
            filesystem: metric(v.filesystem, p => { const totalBytes = count(p.totalBytes), availableBytes = count(p.availableBytes), r = p.root === null ? null : root(p.root); if (availableBytes > totalBytes || r && (r.runtimeId !== node.runtimeId || r.policyRevision !== policyRevision))
                fail(); return { root: r, totalBytes, availableBytes }; }, ['root', 'totalBytes', 'availableBytes']),
            process: metric(v.process, p => ({ cpuUserMicros: count(p.cpuUserMicros), cpuSystemMicros: count(p.cpuSystemMicros), rssBytes: count(p.rssBytes), heapUsedBytes: count(p.heapUsedBytes), heapTotalBytes: count(p.heapTotalBytes), externalBytes: count(p.externalBytes), uptimeSeconds: count(p.uptimeSeconds) }), ['cpuUserMicros', 'cpuSystemMicros', 'rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'uptimeSeconds']) };
        return { node, policyRevision, status: 'available', sample } as NodePublishingResults[M];
    }
    if (typeof p.resourcesShared !== 'boolean' || !Array.isArray(p.roots))
        fail();
    const roots = (p.roots as unknown[]).map(v => { const entry = rec(v, ['root', 'label']), r = root(entry.root); if (r.runtimeId !== node.runtimeId || r.policyRevision !== policyRevision)
        fail(); return { root: r, label: text(entry.label) }; });
    if (new Set(roots.map(r => r.root.rootId)).size !== roots.length)
        fail();
    let landing: NodeLanding | null = null;
    if (p.landing !== null) {
        const l = rec(p.landing, ['root', 'path']), r = root(l.root);
        if (!roots.some(e => same(e.root, r)))
            fail();
        let path: string;
        try {
            path = nodeRelativePath(l.path);
        }
        catch {
            return fail();
        }
        landing = { root: r, path };
    }
    return { node, policyRevision, resourcesShared: p.resourcesShared, roots, landing } as NodePublishingResults[M];
}
