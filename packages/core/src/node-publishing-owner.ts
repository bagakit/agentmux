import { cpus, freemem, totalmem, uptime, loadavg, platform, arch } from 'node:os';
import { mkdir, readFile, realpath, stat, statfs } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AgentMuxError } from './errors.js';
import { durableWriteFile } from './durable-write.js';
import { mintObjectId } from './object-id.js';
import { readNodePublishedDirectory, type NodeDirectoryWitness } from './node-publishing-files.js';
import { NodeLocationSource } from './node-location-source.js';
import { parseNodePublishingPolicy, type NodePublishingPolicy, type NodePolicyOperation, type NodeSettings, type NodePublication, type NodeRootReference, type NodeResources, type NodeResourceSample, type NodeMetric, type NodePublishingMethod, type NodePublishingParams, type NodePublishingResults, type NodePublishingPort } from './node-publishing.js';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const inside = (root: string, path: string) => path === root || path.startsWith(root === sep ? root : root + sep);
const defaultPolicy = (): NodePublishingPolicy => ({ alias: '', shareResources: false, allowedPaths: [], deniedPaths: [], defaultPath: null });
type Root = {
    configured: string;
    id: string;
    witness: NodeDirectoryWitness | null;
};
type State = {
    schema: 'agentmux.node-publication.v1';
    runtimeId: string;
    revision: string;
    policy: NodePublishingPolicy;
    roots: Root[];
    denied: string[];
    operationId: string | null;
};
type Operation = {
    runtimeId: string;
    input: NodePublishingParams['settings.node.configure'];
    result: NodePolicyOperation;
};
const denied = (message: string, code: string): never => { throw new AgentMuxError(message, code); };
const witness = async (path: string): Promise<NodeDirectoryWitness> => { const info = await stat(path, { bigint: true }); if (!info.isDirectory())
    throw new Error('Not a directory'); return { path, device: String(info.dev), inode: String(info.ino) }; };
/** Sole persisted publication owner; it never owns or gates an Agent, Run or SSH capability. */
export class NodePublishingOwner implements NodePublishingPort {
    private tail: Promise<void> = Promise.resolve();
    private readonly file: string;
    private readonly locations = new NodeLocationSource();
    private reading: Promise<State> | undefined;
    constructor(private readonly options: {
        stateDirectory: string;
        runtimeId: string;
        ownerInstanceId: string;
        meshPeer?: () => { networkId: string; peerId: string } | undefined;
        /** Test/embedding durability port; the production default confirms file and naming directory. */
        write?: typeof durableWriteFile;
    }) { this.file = join(options.stateDirectory, 'node-publication.json'); }
    private async write(path: string, value: unknown) {
        try { await (this.options.write ?? durableWriteFile)(path, JSON.stringify(value) + '\n', { requireDirectorySync: true }); }
        finally { if (path === this.file) this.reading = undefined; }
    }
    private node(state: State) { return { runtimeId: this.options.runtimeId, ownerInstanceId: this.options.ownerInstanceId, alias: state.policy.alias }; }
    private root(state: State, original: Root): NodeRootReference { return { runtimeId: this.options.runtimeId, rootId: original.id, policyRevision: state.revision }; }
    private parse(value: unknown): State {
        const v = value as State;
        if (v?.schema !== 'agentmux.node-publication.v1' || v.runtimeId !== this.options.runtimeId || typeof v.revision !== 'string' || !Array.isArray(v.roots) || !Array.isArray(v.denied))
            throw new Error('Wrong publication owner');
        const policy = parseNodePublishingPolicy(v.policy);
        if (!isDeepStrictEqual(v.roots.map(r => r.configured), policy.allowedPaths) || v.roots.some(r => r.id !== digest([this.options.runtimeId, r.configured]) || r.witness && (typeof r.witness.path !== 'string' || typeof r.witness.device !== 'string' || typeof r.witness.inode !== 'string')))
            throw new Error('Wrong publication roots');
        return { ...v, policy };
    }
    private state(): Promise<State> {
        if (!this.reading) {
            const work = this.readState();
            this.reading = work;
            void work.finally(() => { if (this.reading === work) this.reading = undefined; }).catch(() => {});
        }
        return this.reading;
    }
    private async readState(): Promise<State> {
        try {
            return this.parse(JSON.parse(await readFile(this.file, 'utf8')));
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                return denied('The original Node publication is unreadable. Restore its owner settings; existing Agent and owner capabilities remain available.', 'NODE_PUBLICATION_UNAVAILABLE');
            const state: State = { schema: 'agentmux.node-publication.v1', runtimeId: this.options.runtimeId, revision: mintObjectId(), policy: defaultPolicy(), roots: [], denied: [], operationId: null };
            try { await this.write(this.file, state); }
            catch { return denied('The Node publication could not be initialized durably. Its owner can inspect storage; existing Agent and owner capabilities remain available.', 'NODE_PUBLICATION_UNAVAILABLE'); }
            return state;
        }
    }
    private operationPath(id: string) { return join(this.options.stateDirectory, 'node-publication-operations', digest(id) + '.json'); }
    private async operation(id: string): Promise<Operation | null> {
        try {
            const op = JSON.parse(await readFile(this.operationPath(id), 'utf8')) as Operation;
            if (op.runtimeId !== this.options.runtimeId || op.input.operationId !== id || op.result.operationId !== id)
                throw new Error('Wrong operation owner');
            return op;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            return denied('This original Node policy operation is unreadable. Keep its ID and restore the owner record; it has not been replayed.', 'NODE_POLICY_OPERATION_UNAVAILABLE');
        }
    }
    private settings(state: State, operation: NodePolicyOperation | null): NodeSettings { return { node: this.node(state), policyRevision: state.revision, policy: structuredClone(state.policy), operation }; }
    private async inspect(operationId?: string): Promise<NodeSettings> {
        const state = await this.state(), id = operationId ?? state.operationId, op = id ? await this.operation(id) : null;
        if (id && state.operationId === id && op === null)
            return denied('The current policy names an unavailable original save record. Keep its operation ID and restore that owner record; do not replay it.', 'NODE_POLICY_OPERATION_UNAVAILABLE');
        if (op?.result.status === 'unknown' && state.revision === op.result.revision && state.operationId === id) {
            // Confirm the already observed exact bytes; this never reapplies configuration.
            try {
                await this.write(this.file, state);
                const confirmed = { ...op, result: { ...op.result, status: 'confirmed' as const, updatedAt: Date.now() } };
                delete confirmed.result.cause;
                await this.write(this.operationPath(id!), confirmed);
                op.result = confirmed.result;
            }
            catch { /* The original unknown operation remains inspectable without replay. */ }
        }
        return this.settings(state, op?.result ?? null);
    }
    private configure(input: NodePublishingParams['settings.node.configure']): Promise<NodeSettings> {
        const work = this.tail.then(async () => {
            const current = await this.state(), existing = await this.operation(input.operationId);
            if (existing) {
                if (!isDeepStrictEqual(existing.input, input))
                    return denied('This policy operation belongs to another original intent.', 'NODE_POLICY_OPERATION_MISMATCH');
                return this.inspect(input.operationId);
            }
            if (current.revision !== input.expectedRevision)
                return denied('Node settings changed. Read the current policy and preserve your edits before saving.', 'NODE_POLICY_CHANGED');
            const policy = parseNodePublishingPolicy(input.policy);
            // An older operator may submit only the fields it understands.
            if (current.policy.mapLocation && !policy.mapLocation) policy.mapLocation = current.policy.mapLocation;
            policy.allowedPaths = policy.allowedPaths.map(p => resolve(p));
            policy.deniedPaths = policy.deniedPaths.map(p => resolve(p));
            policy.defaultPath = policy.defaultPath === null ? null : resolve(policy.defaultPath);
            if (new Set(policy.allowedPaths).size !== policy.allowedPaths.length || new Set(policy.deniedPaths).size !== policy.deniedPaths.length)
                return denied('Use distinct original publication paths.', 'INVALID_CONTROL_REQUEST');
            if (policy.defaultPath !== null && (!policy.allowedPaths.some(p => inside(p, policy.defaultPath!)) || policy.deniedPaths.some(p => inside(p, policy.defaultPath!))))
                return denied('The default path must belong to an allowed, non-excluded root.', 'NODE_DEFAULT_UNPUBLISHED');
            const roots = await Promise.all(policy.allowedPaths.map(async (configured) => { let observed: NodeDirectoryWitness | null = null; try {
                observed = await witness(await realpath(configured));
            }
            catch { /* Declared but unavailable: no IO authority is inferred. */ } return { configured, id: digest([this.options.runtimeId, configured]), witness: observed }; }));
            const excluded = await Promise.all(policy.deniedPaths.map(async (path) => { try {
                return await realpath(path);
            }
            catch {
                return path;
            } }));
            const revision = mintObjectId(), op: Operation = { runtimeId: this.options.runtimeId, input: structuredClone(input), result: { operationId: input.operationId, expectedRevision: input.expectedRevision, revision, status: 'unknown', updatedAt: Date.now() } };
            const next: State = { ...current, revision, policy, roots, denied: [...new Set([...policy.deniedPaths, ...excluded])], operationId: input.operationId };
            await mkdir(dirname(this.operationPath(input.operationId)), { recursive: true, mode: 0o700 });
            await this.write(this.operationPath(input.operationId), op);
            try {
                await this.write(this.file, next);
                op.result = { ...op.result, status: 'confirmed', updatedAt: Date.now() };
                await this.write(this.operationPath(input.operationId), op);
            }
            catch {
                op.result = { ...op.result, status: 'unknown', cause: { code: 'NODE_POLICY_DURABILITY_UNCONFIRMED', message: 'The original policy save was not acknowledged. Inspect this operation; do not replay it.' } };
            }
            return this.settings(await this.state(), op.result);
        });
        this.tail = work.then(() => { }, () => { });
        return work;
    }
    private publication(state: State): NodePublication {
        const published = state.roots.filter(r => !state.denied.some(p => inside(p, r.configured) || r.witness && inside(p, r.witness.path)));
        const roots = published.map(r => ({ root: this.root(state, r), label: basename(r.configured) || 'Root directory' }));
        const selected = state.policy.defaultPath === null ? undefined : [...published].sort((a, b) => b.configured.length - a.configured.length).find(r => inside(r.configured, state.policy.defaultPath!));
        return { node: this.node(state), policyRevision: state.revision, resourcesShared: state.policy.shareResources, roots,
            landing: selected ? { root: this.root(state, selected), path: relative(selected.configured, state.policy.defaultPath!).split(sep).join('/') } : null };
    }
    private async resources(state: State, owner: boolean, signal?: AbortSignal): Promise<NodeResources> {
        signal?.throwIfAborted();
        const node = this.node(state), policyRevision = state.revision;
        if (!owner && !state.policy.shareResources)
            return { node, policyRevision, status: 'withheld' };
        const read = async <T>(action: () => T | Promise<T>, code: string): Promise<NodeMetric<T>> => { signal?.throwIfAborted(); try {
            return { state: 'available', value: await action() };
        }
        catch {
            signal?.throwIfAborted();
            return { state: 'unavailable', code, message: 'This original Node measurement is unavailable.' };
        } };
        const publication = this.publication(state), landing = publication.landing;
        const [system, cpu, memory, filesystem, own, filesystemIo] = await Promise.all([
            read(() => ({ platform: platform(), architecture: arch(), uptimeSeconds: uptime() }), 'NODE_SYSTEM_UNAVAILABLE'),
            read(() => { const values = cpus(); if (!values.length)
                throw new Error('No CPU counters'); return { logicalCpus: values.length, userMs: values.reduce((n, c) => n + c.times.user, 0), niceMs: values.reduce((n, c) => n + c.times.nice, 0), systemMs: values.reduce((n, c) => n + c.times.sys, 0), idleMs: values.reduce((n, c) => n + c.times.idle, 0), irqMs: values.reduce((n, c) => n + c.times.irq, 0), loadAverage: loadavg() as [
                    number,
                    number,
                    number
                ] }; }, 'NODE_CPU_UNAVAILABLE'),
            read(() => ({ totalBytes: totalmem(), freeBytes: freemem() }), 'NODE_MEMORY_UNAVAILABLE'),
            read(async () => {
                const selected = landing ? state.roots.find(r => r.id === landing.root.rootId) : undefined;
                if (landing && !selected?.witness) throw new Error('Published root unavailable');
                const original = selected?.witness;
                const location = original ? original.path : this.options.stateDirectory;
                const confirm = async () => {
                    if (!original || !selected) return;
                    if (!isDeepStrictEqual(await witness(await realpath(selected.configured)), original) ||
                        (await this.exclusions(state)).some(path => inside(path, original.path))) throw new Error('Published filesystem source changed');
                };
                await confirm();
                const fs = await statfs(location);
                await confirm();
                return { root: landing?.root ?? null, totalBytes: fs.blocks * fs.bsize, availableBytes: Math.max(0, fs.bavail * fs.bsize) };
            }, 'NODE_FILESYSTEM_UNAVAILABLE'),
            read(() => { const cpu = process.cpuUsage(), m = process.memoryUsage(); return { cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, rssBytes: m.rss, heapUsedBytes: m.heapUsed, heapTotalBytes: m.heapTotal, externalBytes: m.external, uptimeSeconds: process.uptime() }; }, 'NODE_PROCESS_UNAVAILABLE'),
            read(() => {
                const usage = process.resourceUsage();
                if (![usage.fsRead, usage.fsWrite].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid original I/O counters');
                return { scope: platform() === 'win32' ? 'process-io' as const : 'filesystem' as const, readOperations: usage.fsRead, writeOperations: usage.fsWrite };
            }, 'NODE_PROCESS_IO_UNAVAILABLE')
        ]);
        signal?.throwIfAborted();
        const after = await this.state();
        if (!owner && !after.policy.shareResources)
            return { node: this.node(after), policyRevision: after.revision, status: 'withheld' };
        if (!owner && after.revision !== state.revision)
            return denied('Node publication changed during this observation. Read the same Node again.', 'NODE_POLICY_CHANGED');
        const sample: NodeResourceSample = { node, policyRevision, processId: process.pid, observedAt: Date.now(), system, cpu, memory, filesystem, process: own, filesystemIo };
        return { node, policyRevision, status: 'available', sample };
    }
    private async exclusions(state: State): Promise<string[]> {
        const current = await Promise.all(state.policy.deniedPaths.map(async (path) => { try {
            return await realpath(path);
        }
        catch {
            return path;
        } }));
        return [...new Set([...state.denied, ...current])].sort();
    }
    private async files(method: 'node.files.list' | 'node.files.read', input: NodePublishingParams['node.files.list'] | NodePublishingParams['node.files.read'], state: State, signal?: AbortSignal): Promise<unknown> {
        if (input.root.runtimeId !== this.options.runtimeId)
            return denied('This published root belongs to another original Node.', 'NODE_ROOT_MISMATCH');
        if (input.root.policyRevision !== state.revision)
            return denied('This publication changed. Refresh published directories before reading this original resource.', 'NODE_POLICY_CHANGED');
        const original = state.roots.find(r => r.id === input.root.rootId);
        if (!original)
            return denied('This root is not published. Read the current published directories.', 'NODE_ROOT_UNPUBLISHED');
        if (!original.witness)
            return denied('The original published root was unavailable when saved. Inspect owner settings before publishing it again.', 'NODE_ROOT_UNAVAILABLE');
        try {
            if (await realpath(original.configured) !== original.witness.path)
                return denied('The original published root changed. Review the same root before publishing it again.', 'NODE_PATH_CHANGED');
        }
        catch (error) {
            if (error instanceof AgentMuxError)
                throw error;
            return denied('The original published root is unavailable. Refresh its owner settings.', 'NODE_ROOT_UNAVAILABLE');
        }
        const exclusions = await this.exclusions(state);
        const logical = resolve(original.configured, input.path);
        if (!inside(original.configured, logical) || exclusions.some(p => inside(p, logical)))
            return denied('This path is excluded from the Node publication.', 'NODE_PATH_DENIED');
        let target: string;
        try {
            target = await realpath(resolve(original.witness.path, input.path));
        }
        catch {
            return denied('The original shared resource is unavailable. Refresh its published root and original path.', 'NODE_READ_UNAVAILABLE');
        }
        if (!inside(original.witness.path, target) || exclusions.some(p => inside(p, target)))
            return denied('This path escapes or is excluded from the published root.', 'NODE_PATH_DENIED');
        const directory = method === 'node.files.list' ? target : dirname(target), w = await witness(directory);
        const result = await readNodePublishedDirectory({ root: original.witness, directory: w, logicalDirectory: method === 'node.files.list' ? logical : dirname(logical), denied: exclusions, action: method === 'node.files.list' ? 'list' : 'read', name: basename(target), offset: input.offset ?? 0, limit: method === 'node.files.list' ? (input as NodePublishingParams['node.files.list']).limit ?? 100 : 0, maxBytes: method === 'node.files.read' ? (input as NodePublishingParams['node.files.read']).maxBytes ?? 64 * 1024 : 0, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) }, signal);
        if (await realpath(original.configured) !== original.witness.path || !isDeepStrictEqual(exclusions, await this.exclusions(state)))
            return denied('The published path or exclusions changed during the read. Refresh the original directory; no bytes were returned.', 'NODE_PATH_CHANGED');
        const after = await this.state();
        if (after.revision !== state.revision)
            return denied('This publication changed during the read. Refresh published directories; no bytes were returned.', 'NODE_POLICY_CHANGED');
        return { root: input.root, path: input.path, ...result as object };
    }
    async call<M extends NodePublishingMethod>(method: M, input: NodePublishingParams[M], signal?: AbortSignal): Promise<NodePublishingResults[M]> {
        signal?.throwIfAborted();
        if (method === 'settings.node.configure')
            return await this.configure(input as NodePublishingParams['settings.node.configure']) as NodePublishingResults[M];
        if (method === 'settings.node.inspect') {
            const work = this.tail.then(() => this.inspect((input as NodePublishingParams['settings.node.inspect']).operationId));
            this.tail = work.then(() => {}, () => {});
            return await work as NodePublishingResults[M];
        }
        const state = await this.state().catch(error => { if (method.startsWith('settings.node.') || error instanceof AgentMuxError)
            throw error; return denied('The original Node publication is unavailable. Ask its owner to inspect the saved settings.', 'NODE_PUBLICATION_UNAVAILABLE'); }), route = input as NodePublishingParams['node.inspect'];
        if (route.expectedRuntimeId !== undefined && route.expectedRuntimeId !== this.options.runtimeId)
            return denied('This route reached a different original Node Runtime.', 'NODE_RUNTIME_MISMATCH');
        if (method === 'node.location') {
            const location = await this.locations.read(this.options.runtimeId, state.policy.mapLocation, signal);
            signal?.throwIfAborted();
            const current = await this.state();
            const published = isDeepStrictEqual(current.policy.mapLocation, state.policy.mapLocation) ? location : null;
            const meshPeer = published ? this.options.meshPeer?.() : undefined;
            return { node: this.node(current), location: published, ...(meshPeer ? { meshPeer } : {}) } as NodePublishingResults[M];
        }
        if (method === 'node.resources' || method === 'settings.node.resources')
            return await this.resources(state, method === 'settings.node.resources', signal) as NodePublishingResults[M];
        if (method === 'node.files.list' || method === 'node.files.read') {
            try {
                return await this.files(method, input as NodePublishingParams['node.files.list'], state, signal) as NodePublishingResults[M];
            }
            catch (error) {
                signal?.throwIfAborted();
                if (error instanceof AgentMuxError)
                    throw error;
                return denied('This original shared resource is unavailable. Refresh the published root and original path.', 'NODE_READ_UNAVAILABLE');
            }
        }
        if (method === 'node.resolve') {
            const q = input as NodePublishingParams['node.resolve'];
            if (q.expectedRuntimeId === undefined && q.alias !== undefined && q.alias !== state.policy.alias)
                return denied('The published alias changed or belongs to another Node. Resolve its exact original Runtime.', 'NODE_ALIAS_MISMATCH');
        }
        return this.publication(state) as NodePublishingResults[M];
    }
}
