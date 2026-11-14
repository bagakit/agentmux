import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js';
import { pathToFileURL } from 'node:url';
const { AgentMuxControlServer } = process.env.SPACE_AUTHORITY_COMPILED_CORE ? await import(/* @vite-ignore */ pathToFileURL(join(process.env.SPACE_AUTHORITY_COMPILED_CORE, 'dist/public-rpc-server.js')).href) : await import('../src/public-rpc-server.js');
import { connectAgentMuxRpc } from '../src/public-rpc-client.js';
const { spaceTransfer: producerSpaceTransfer } = process.env.SPACE_AUTHORITY_COMPILED_CORE ? await import(/* @vite-ignore */ pathToFileURL(join(process.env.SPACE_AUTHORITY_COMPILED_CORE, 'dist/space-authority-stream.js')).href) : await import('../src/space-authority-stream.js');
const { SpaceAuthorityOwner } = process.env.SPACE_AUTHORITY_COMPILED_CORE ? await import(/* @vite-ignore */ pathToFileURL(join(process.env.SPACE_AUTHORITY_COMPILED_CORE, 'dist/space-authority-owner.js')).href) : await import('../src/space-authority-owner.js');
import { readSpaceSnapshot, observeSpace, SpaceTransferReader, spaceStreamOpening } from '../src/space-authority-stream.js';
import { applySpaceChange, type SpaceSnapshot, type SpaceChange } from '../src/space-authority.js';
import type { AgentMuxSpatialGraph } from '../src/spatial-graph.js';
import { createWorkbenchViewLayout, splitWorkbenchRegion, regionIds } from '../src/spatial-layout.js';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
    for (const release of cleanup.splice(0).reverse())
        await release();
    vi.restoreAllMocks();
});
function graph(): AgentMuxSpatialGraph {
    return {
        spaces: ['same-space', 'unrelated'].map(spaceId => ({ spaceId, kind: 'folder', name: spaceId, hostId: 'local', directoryPath: '/original/' + spaceId, projectId: null })),
        zones: ['zone', 'other-zone'].map(zoneId => ({ zoneId, workspaceId: zoneId, kind: 'directory', hostId: 'local', directoryPath: '/original/' + zoneId, branch: null })),
        tabs: ['tab', 'other-tab'].map((tabId, i) => ({ tabId, zoneId: i ? 'other-zone' : 'zone', workspaceId: i ? 'other-zone' : 'zone', name: null, regionIds: [i ? 'other-region' : 'region'] })),
        regions: ['region', 'other-region'].map((regionId, i) => ({ regionId, tabId: i ? 'other-tab' : 'tab', kind: 'agent', agentSessionId: i ? 'unrelated-session' : 'original-session', runId: i ? 'unrelated-run' : 'original-run', execution: { hostId: i ? 'local' : 'agent-route', cwd: i ? '/unrelated-agent' : '/original-agent' } })),
        bindings: [{ spaceId: 'same-space', zoneId: 'zone' }, { spaceId: 'unrelated', zoneId: 'other-zone' }],
        layouts: { zone: { root: { type: 'leaf', groupId: 'group' }, groups: [{ id: 'group', tabOrder: ['tab'], recentTabIds: [], activeTabId: 'tab' }], activeGroupId: 'group' } },
        tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' }, 'other-tab': { root: { type: 'leaf', regionId: 'other-region' }, activeRegionId: 'other-region' } },
        resources: { 'region:region': { agentPresentation: { hostId: 'agent-route', agentSessionId: 'original-session' }, value: 0 }, 'region:other-region': { secret: 'unrelated' }, 'core:private': { secret: 'not-a-space-resource' } }
    };
}
async function fixture(runtimeId = 'runtime-b') {
    const root = await mkdtemp(join(tmpdir(), 'amx-space-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = new AgentMuxSpatialStateStore(join(root, 'spatial-state.json'));
    await store.commit({ expectedRevision: 0, graph: graph() });
    const source = { runtimeId, ownerInstanceId: 'source-instance' };
    let identityReads = 0;
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), spatialState: store, coreClients: () => [], hostedRuntime: () => ({
            call: async (method: string) => {
                if (method !== 'runtime.owner.identity')
                    throw new Error('Unrelated Runtime observation');
                identityReads++;
                return { owner: { ...source, protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' } };
            },
            subscribe: async () => { throw new Error('Eager Session/PTY subscription'); }, assertFence: () => { }
        }) as never });
    cleanup.push(() => server.stop());
    await server.start();
    const connect = async () => { const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose()); return rpc; };
    return { root, store, source, connect, reference: { runtimeId, spaceId: 'same-space' }, owner: new SpaceAuthorityOwner(store, async () => source), identityReads: () => identityReads };
}
async function observed<T>(read: () => T, accept: (value: T) => boolean): Promise<T> { return await vi.waitFor(() => { const value = read(); expect(accept(value), 'Expected original Space observation to arrive').toBe(true); return value; }, { timeout: 5000, interval: 10 }); }
describe('original Space authority through the production RPC client/server', () => {
    it('removes an exact unobserved member and its saved split leaf through the original spatial writer', async () => {
        const f = await fixture(), original = graph();
        original.tabs[0]!.regionIds.push('kept-region');
        original.regions.push({ ...original.regions[0]!, regionId: 'kept-region', agentSessionId: 'kept-session' });
        original.regions[0] = { ...original.regions[0]!, runId: null, execution: null };
        original.tabLayouts.tab = splitWorkbenchRegion(createWorkbenchViewLayout('region'), 'region', 'right', 'kept-region');
        await f.store.commit({ expectedRevision: 1, graph: original });
        const rpc = await f.connect();
        const receipt = await rpc.call('space.apply', { reference: f.reference, expectedRevision: 2,
            changes: { tabs: [{ ...original.tabs[0]!, regionIds: ['kept-region'] }], remove: { regions: ['region'] } } });
        expect(receipt).toMatchObject({ revision: 3, diskDurability: 'confirmed' });
        const saved = (await f.store.read())!;
        expect(saved.graph.regions.some(region => region.regionId === 'region')).toBe(false);
        expect(regionIds(saved.graph.tabLayouts.tab!.root)).toEqual(['kept-region']);
        expect(saved.graph.tabLayouts.tab!.activeRegionId).toBe('kept-region');
        expect(saved.graph.regions.find(region => region.regionId === 'kept-region')?.agentSessionId).toBe('kept-session');
        expect(saved.graph.resources).toEqual(original.resources);
        const reopened = new AgentMuxSpatialStateStore(f.store.path);
        expect((await reopened.read())!.graph.tabLayouts).toEqual(saved.graph.tabLayouts);
    });
    it('retires the removed Tab occurrences while preserving other original workfaces and recovery descriptors', async () => {
        const f = await fixture(), rpc = await f.connect(), original = graph();
        await rpc.call('space.apply', { reference: f.reference, expectedRevision: 1,
            changes: { remove: { tabs: ['tab'], regions: ['region'] } } });
        const saved = (await f.store.read())!;
        expect(saved.graph.layouts.zone!.groups[0]!.tabOrder).toEqual([]);
        expect(saved.graph.layouts.zone!.groups[0]!.activeTabId).toBeNull();
        expect(saved.graph.tabLayouts.tab).toBeUndefined();
        expect(saved.graph.tabLayouts['other-tab']).toEqual(original.tabLayouts['other-tab']);
        for (const [key, value] of Object.entries(original.resources)) expect(saved.graph.resources[key]).toEqual(value);
    });
    it('scopes the original graph, Session refs and content without guessing a client-local Host route', async () => {
        const f = await fixture(), rpc = await f.connect();
        const snapshot = await readSpaceSnapshot(rpc, f.reference);
        expect(snapshot.source).toEqual(f.source);
        expect(snapshot.scope.zones.map(z => z.zoneId)).toEqual(['zone']);
        expect(snapshot.scope.regions).toMatchObject([{ agentSessionId: 'original-session', runId: 'original-run', execution: { hostId: 'agent-route' } }]);
        expect(snapshot.scope).not.toHaveProperty('resources');
        expect(snapshot.scope).not.toHaveProperty('tabLayouts');
        expect(snapshot.scope).not.toHaveProperty('locations');
        expect(snapshot.scope).not.toHaveProperty('layouts');
        expect(snapshot).not.toHaveProperty('graph');
    });
    it('rejects another Runtime with the same Space ID before substituting its local Space', async () => {
        const a = await fixture('runtime-a'), b = await fixture('runtime-b');
        const rpc = await b.connect();
        const wrongWrite = await rpc.call('space.apply', { reference: a.reference, expectedRevision: 1, changes: { zones: [{ ...graph().zones[0]!, branch: 'wrong-runtime-write' }] } }).then(value => ({ value }), error => ({ error }));
        expect((await b.store.read())!.revision, 'A reply guard cannot undo a wrong-source write').toBe(1);
        expect(wrongWrite).toMatchObject({ error: { code: 'RUNTIME_OWNER_MISMATCH' } });
        await expect(readSpaceSnapshot(rpc, a.reference)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' });
        const right = await readSpaceSnapshot(rpc, b.reference);
        expect(right.reference).toEqual(b.reference);
    });
    it('uses the original CAS for two writers and preserves every unrelated entity/resource', async () => {
        const f = await fixture(), a = await f.connect(), b = await f.connect();
        const original = await f.store.read();
        const changes = [1, 2].map(value => ({ zones: [{ ...graph().zones[0]!, branch: String(value) }] }));
        const writes = await Promise.allSettled(changes.map((change, i) => (i ? a : b).call('space.apply', { reference: f.reference, expectedRevision: 1, changes: change })));
        expect(writes.filter(w => w.status === 'fulfilled')).toHaveLength(1);
        expect(writes.filter(w => w.status === 'rejected')).toMatchObject([{ reason: { code: 'SPATIAL_STATE_CONFLICT' } }]);
        const saved = (await f.store.read())!;
        expect(saved.graph.spaces).toEqual(original!.graph.spaces);
        expect(saved.graph.regions).toEqual(original!.graph.regions);
        expect(saved.graph.resources['region:other-region']).toEqual(original!.graph.resources['region:other-region']);
        expect(saved.graph.resources['core:private']).toEqual(original!.graph.resources['core:private']);
        expect(saved.graph.tabs).toEqual(original!.graph.tabs);
        expect(saved.graph.bindings).toEqual(original!.graph.bindings);
    });
    it('does not treat a filtered snapshot or a foreign edit as a whole-source write', async () => {
        const f = await fixture(), rpc = await f.connect(), saved = await readFile(f.store.path, 'utf8');
        const snapshot = await readSpaceSnapshot(rpc, f.reference);
        await expect(rpc.call('space.apply', { reference: f.reference, expectedRevision: 1, changes: snapshot.scope as never })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' });
        await expect(rpc.call('space.apply', { reference: f.reference, expectedRevision: 1, changes: { zones: [{ ...graph().zones[1]!, branch: 'foreign' }] } })).rejects.toMatchObject({ code: 'SPACE_PARENT_MISMATCH' });
        expect(await readFile(f.store.path, 'utf8')).toBe(saved);
    });
    it('adds a Zone binding on the original authority without replacing unrelated Space membership', async () => {
        const f = await fixture(), rpc = await f.connect();
        const result = await rpc.call('space.apply', { reference: f.reference, expectedRevision: 1, changes: { bindings: [{ spaceId: 'same-space', zoneId: 'zone' }, { spaceId: 'same-space', zoneId: 'other-zone' }] } });
        expect(result.diskDurability).toBe('confirmed');
        expect((await readSpaceSnapshot(rpc, f.reference)).scope.regions).toHaveLength(2);
        expect((await f.store.read())!.graph.bindings).toContainEqual({ spaceId: 'unrelated', zoneId: 'other-zone' });
    });
    it('opens snapshot+ordered entity delta, ignores unrelated writes and permits exact client reduction', async () => {
        const f = await fixture(), rpc = await f.connect(), writer = await f.connect();
        let current: SpaceSnapshot | undefined;
        const changes: SpaceChange[] = [];
        const sub = await observeSpace(rpc, { reference: f.reference }, { onChange: (snapshot, change) => { changes.push(change); current = snapshot; } });
        current = sub.initial;
        cleanup.push(() => sub.dispose());
        let state = (await f.store.read())!;
        state.graph.zones[1]!.branch = 'unrelated';
        await f.store.commit({ expectedRevision: state.revision, graph: state.graph });
        const final = await writer.call('space.apply', { reference: f.reference, expectedRevision: 2, changes: { zones: [{ ...graph().zones[0]!, branch: '3' }] } });
        await observed(() => current, v => v?.revision === 3);
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ fromRevision: 1, revision: 3, delta: { zones: [{ zoneId: 'zone', branch: '3' }] } });
        expect(changes[0]!.delta).not.toHaveProperty('regions');
        expect(current).toEqual(await readSpaceSnapshot(rpc, f.reference));
        expect(final).toMatchObject({ revision: 3, diskDurability: 'confirmed' });
    });
    it('closes the source read/subscribe race and reports resnapshot rather than claiming retained delta history', async () => {
        const f = await fixture(), rpc = await f.connect();
        const events: SpaceChange[] = [];
        let opening: SpaceSnapshot | undefined;
        const sub = await observeSpace(rpc, { reference: f.reference, after: { runtimeId: 'old-runtime', revision: 0 } }, { onChange: (_snapshot, change) => events.push(change) });
        expect(sub.gap).toMatchObject({ requested: { runtimeId: 'old-runtime', revision: 0 }, reason: 'snapshot-required' });
        opening = sub.initial;
        cleanup.push(() => sub.dispose());
        const writer = await f.connect();
        await writer.call('space.apply', { reference: f.reference, expectedRevision: 1, changes: { zones: [{ ...graph().zones[0]!, branch: '4' }] } });
        await observed(() => events, v => v.length > 0);
        expect(applySpaceChange(opening!, events[0]!)).toMatchObject({ revision: 2, scope: { zones: [{ zoneId: 'zone', branch: '4' }] } });
    });
    it('releases only its cancelled reader; another reader and the original document remain available', async () => {
        const f = await fixture(), rpc = await f.connect(), a: SpaceChange[] = [], b: SpaceChange[] = [];
        const first = await observeSpace(rpc, { reference: f.reference }, { onChange: (_snapshot, change) => a.push(change) });
        const second = await observeSpace(rpc, { reference: f.reference }, { onChange: (_snapshot, change) => b.push(change) });
        cleanup.push(() => second.dispose());
        await first.dispose();
        await rpc.call('space.apply', { reference: f.reference, expectedRevision: 1, changes: { zones: [{ ...graph().zones[0]!, branch: '5' }] } });
        await observed(() => b, v => v.length === 1);
        expect(a).toHaveLength(0);
        expect((await readSpaceSnapshot(rpc, f.reference)).revision).toBe(2);
    });
    it('coalesces a slow reader to one pending source state without blocking original commits', async () => {
        const f = await fixture();
        cleanup.push(() => f.owner.dispose());
        const events: SpaceChange[] = [];
        let release!: () => void;
        const gate = new Promise<void>(yes => { release = yes; });
        const watch = await f.owner.watch({ reference: f.reference }, async (event) => {
            if (event.type === 'change') {
                events.push(event.data);
                if (events.length === 1)
                    await gate;
            }
        });
        cleanup.push(() => watch.dispose());
        watch.start();
        for (let value = 1; value <= 5; value++)
            await f.owner.apply({ reference: f.reference, expectedRevision: value, changes: { zones: [{ ...graph().zones[0]!, branch: String(value) }] } });
        expect(events).toHaveLength(1);
        release();
        await observed(() => events, v => v.length === 2);
        const final = events.reduce(applySpaceChange, watch.initial.snapshot);
        expect(final.revision).toBe(6);
        expect(final.scope.zones[0]!.branch).toBe('5');
    });
    it('keeps original bytes and the last confirmed observation when the source becomes unreadable', async () => {
        const f = await fixture(), rpc = await f.connect();
        const original = await readSpaceSnapshot(rpc, f.reference);
        await writeFile(f.store.path, '{original-corrupt');
        await expect(readSpaceSnapshot(rpc, f.reference)).rejects.toMatchObject({ code: 'SPATIAL_STATE_READ_UNCONFIRMED' });
        await expect(rpc.call('space.apply', { reference: f.reference, expectedRevision: 1, changes: { zones: [{ ...graph().zones[0]!, branch: '6' }] } })).rejects.toMatchObject({ code: 'SPATIAL_STATE_READ_UNCONFIRMED' });
        expect(original.scope.regions[0]!.agentSessionId).toBe('original-session');
        expect(await readFile(f.store.path, 'utf8')).toBe('{original-corrupt');
    });
    it('does not publish window-only revisions or expose opaque drafts, and preserves original window bytes on a scoped write', async () => {
        const f = await fixture(), rpc = await f.connect(), events: SpaceChange[] = [];
        const sub = await observeSpace(rpc, { reference: f.reference }, { onChange: (_snapshot, change) => events.push(change) });
        cleanup.push(() => sub.dispose());
        const state = (await f.store.read())!;
        state.graph.layouts.zone!.groups[0]!.activeTabId = null;
        state.graph.resources['region:region'] = { draft: 'private-unsent-intent', focus: 'local-only' };
        (state.graph.tabs[0] as unknown as Record<string, unknown>).privateDraft = 'private-tab-draft';
        (state.graph.zones[0] as unknown as Record<string, unknown>).windowScroll = 42;
        await f.store.commit({ expectedRevision: state.revision, graph: state.graph });
        await rpc.call('space.apply', { reference: f.reference, expectedRevision: 2, changes: { zones: [{ ...graph().zones[0]!, branch: 'business-change' }] } });
        await observed(() => events, value => value.length === 1);
        expect(events[0]).toMatchObject({ fromRevision: 1, revision: 3 });
        expect(JSON.stringify(events)).not.toContain('private-unsent-intent');
        const saved = (await f.store.read())!.graph;
        expect(saved.layouts).toEqual(state.graph.layouts);
        expect(saved.resources).toEqual(state.graph.resources);
        expect(saved.tabLayouts).toEqual(state.graph.tabLayouts);
        expect((saved.zones.find(zone => zone.zoneId === 'zone') as unknown as Record<string, unknown>).windowScroll).toBe(42);
        await expect(readSpaceSnapshot(rpc, f.reference)).resolves.toSatisfy(snapshot => !JSON.stringify(snapshot).includes('private-tab-draft'));
    });
    it('uses the newest original cut when a another original file writer commits during subscription opening', async () => {
        const f = await fixture(), rpc = await f.connect();
        let entered!: () => void, release!: () => void;
        const waiting = new Promise<void>(yes => { entered = yes; }), gate = new Promise<void>(yes => { release = yes; }), original = f.store.readForLayout.bind(f.store);
        let first = true;
        vi.spyOn(f.store, 'readForLayout').mockImplementation(async () => {
            const state = await original();
            if (first) {
                first = false;
                entered();
                await gate;
            }
            return state;
        });
        let committed!: () => void;
        const observedCommit = new Promise<void>(yes => { committed = yes; });
        const detach = f.store.subscribe(state => {
            if (state.revision >= 2)
                committed();
        });
        cleanup.push(detach);
        const opening = observeSpace(rpc, { reference: f.reference });
        await waiting;
        const other = new AgentMuxSpatialStateStore(f.store.path), state = (await other.read())!;
        state.graph.zones[0]!.branch = 'during-opening';
        await other.commit({ expectedRevision: 1, graph: state.graph });
        await observedCommit;
        release();
        const sub = await opening;
        cleanup.push(() => sub.dispose());
        expect(sub.initial).toMatchObject({ revision: 2, scope: { zones: [{ zoneId: 'zone', branch: 'during-opening' }] } });
    });
    it('reads authority only for relevant subscribers, without unrelated consumer fanout', async () => {
        const f = await fixture(), rpc = await f.connect(), state = (await f.store.read())!;
        for (let index = 0; index < 25; index++)
            state.graph.spaces.push({ spaceId: 'extra-' + index, kind: 'folder', name: 'extra', hostId: 'local', directoryPath: '/extra/' + index, projectId: null });
        await f.store.commit({ expectedRevision: 1, graph: state.graph });
        const active: SpaceChange[] = [];
        const sub = await observeSpace(rpc, { reference: f.reference }, { onChange: (_snapshot, change) => active.push(change) });
        cleanup.push(() => sub.dispose());
        for (let index = 0; index < 25; index++) {
            const extra = await observeSpace(rpc, { reference: { ...f.reference, spaceId: 'extra-' + index } }, { onChange: () => { throw new Error('Unrelated Space consumer was notified'); } });
            cleanup.push(() => extra.dispose());
        }
        const beforeReads = f.identityReads();
        const next = (await f.store.read())!;
        next.graph.zones[0]!.branch = 'only-related';
        await f.store.commit({ expectedRevision: 2, graph: next.graph });
        await observed(() => active, value => value.length === 1);
        expect(f.identityReads() - beforeReads).toBe(1);
    });
    it('streams a cumulative Space larger than the Hosted value budget in bounded original frames', () => {
        const path = '/' + ('segment/'.repeat(64)), zones = Array.from({ length: 60000 }, (_, index) => ({ zoneId: 'z-' + index, workspaceId: 'w-' + index, kind: 'directory' as const, hostId: 'source-route', directoryPath: path, branch: null }));
        const snapshot: SpaceSnapshot = { reference: { runtimeId: 'original-runtime', spaceId: 'original-space' }, source: { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance' }, revision: 1, scope: { space: { spaceId: 'original-space', kind: 'folder', name: 'Original', hostId: 'local', directoryPath: '/original', projectId: null }, zones, tabs: [], regions: [], bindings: zones.map(zone => ({ spaceId: 'original-space', zoneId: zone.zoneId })) } };
        const bytes = Buffer.byteLength(JSON.stringify(snapshot));
        expect(bytes).toBeGreaterThan(32 * 1024 * 1024);
        const reader = new SpaceTransferReader(spaceStreamOpening(snapshot));
        let complete: SpaceSnapshot | undefined, maxFrame = 0, frames = 0;
        expect(() => {
            for (const chunk of producerSpaceTransfer(snapshot)) {
                frames++;
                maxFrame = Math.max(maxFrame, Buffer.byteLength(JSON.stringify(chunk)));
                for (const value of reader.accept(chunk))
                    complete = value.snapshot;
            }
        }, 'A cumulative Space must use bounded batches rather than one Hosted value').not.toThrow();
        expect(complete?.scope.zones).toHaveLength(zones.length);
        expect(complete?.scope.bindings).toHaveLength(zones.length);
        expect(maxFrame).toBeLessThan(128 * 1024);
        console.log(JSON.stringify({ spaceCarrier: { totalBusinessJsonBytes: bytes, frames, maxFrameBytes: maxFrame, zoneCount: zones.length, windowFields: 0 } }));
    });
    it('reports unavailable source without erasing its last confirmed Space or replacing bytes', async () => {
        const f = await fixture(), rpc = await f.connect();
        let latest: SpaceSnapshot | undefined, failure: Error | undefined;
        const sub = await observeSpace(rpc, { reference: f.reference }, { onChange: value => { latest = value; }, onError: error => { failure = error; } });
        latest = sub.initial;
        cleanup.push(() => sub.dispose());
        const confirmed = structuredClone(latest);
        await writeFile(f.store.path, '{original-incomplete-document');
        await observed(() => failure, value => value !== undefined);
        expect(latest).toEqual(confirmed);
        expect(await readFile(f.store.path, 'utf8')).toBe('{original-incomplete-document');
        expect(confirmed.scope.regions[0]).toMatchObject({ agentSessionId: 'original-session', runId: 'original-run' });
    });
    it('does not let another presentation consumer failure end the healthy Space reader', async () => {
        const f = await fixture(), rpc = await f.connect(), changes: SpaceChange[] = [], errors: Error[] = [];
        const reader = await observeSpace(rpc, { reference: f.reference }, { onChange: (_snapshot, change) => changes.push(change), onError: error => errors.push(error) });
        cleanup.push(() => reader.dispose());
        const unrelated = f.store.subscribe(() => { throw new Error('Other presentation consumer is unavailable'); });
        cleanup.push(unrelated);
        await rpc.call('space.apply', { reference: f.reference, expectedRevision: 1, changes: { zones: [{ ...graph().zones[0]!, branch: 'still-healthy' }] } });
        await observed(() => changes, value => value.length === 1);
        expect(errors).toEqual([]);
        expect((await readSpaceSnapshot(rpc, f.reference)).scope.regions[0]!.agentSessionId).toBe('original-session');
    });
    it('checks the original write authority again before the scoped CAS side effect', async () => {
        const f = await fixture(), original = await readFile(f.store.path, 'utf8');
        const outcome = await f.owner.apply({ reference: f.reference, expectedRevision: 1, changes: { zones: [{ ...graph().zones[0]!, branch: 'denied-write' }] } }, { assertCurrent: () => { throw new Error('Original authority revoked'); } }).then(value => ({ value }), error => ({ error }));
        expect(await readFile(f.store.path, 'utf8'), 'Revocation must prevent the original durable write, not only a response').toBe(original);
        expect(outcome).toMatchObject({ error: { message: 'Original authority revoked' } });
    });
});
