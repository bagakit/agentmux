import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js';
import { AgentMuxClient } from '../src/client.js';
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js';
import { applyAgentTimelineEvent } from '../src/session-timeline.js';
import { conversationRevision } from '../src/conversation-stream.js';
import type { AgentMuxClientEvent, AgentTimelineItem, AgentTimelineMutation, AgentTimelineSnapshot } from '../src/types.js';
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js';
import { AgentMuxControlServer } from '../src/public-rpc-server.js';
import { connectAgentMuxRpc } from '../src/public-rpc-client.js';
import { AgentMuxHostedTransferReader } from '../src/hosted-value.js';
import { hostedTestOwner, hostedTestFence } from './helpers/hosted-runtime-port.js';
import { capturedStorageSession, capturedStorageSourcePath } from './helpers/captured-history-fixture.js';
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const sid = 'original-metadata-session', host = 'original-source-host';
function item(id = 'original-observation', extra: Partial<AgentTimelineItem> = {}): AgentTimelineItem { return { id, agentSessionId: sid, kind: 'tool_call', status: 'complete', source: 'native-hook', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), title: 'Original observed record', content: 'Original body', ...extra }; }
type TimelineEvent = Extract<AgentMuxClientEvent, {
    type: 'agent-timeline';
}>;
async function fixture(kind: 'memory' | 'file', legacy = false) { const root = await mkdtemp(join(tmpdir(), 'amux-timeline-metadata-')); roots.push(root); const path = join(root, 'sessions.json'), store = kind === 'file' ? new AgentMuxFileAgentSessionStore(path) : new AgentMuxMemoryAgentSessionStore(), session = { ...capturedStorageSession(root, sid), hostId: host }; await store.compareAndSwap(null, session); if (legacy) {
    const p = capturedStorageSourcePath(path, sid);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify({ version: 3, agentSessionId: sid, revision: 31, items: [] }) + '\n');
} return { root, path, store, session }; }
function emitted(commit: Awaited<ReturnType<AgentMuxMemoryAgentSessionStore['applyTimelineMutation']>>) { const publisher = new AgentMuxClientEventPublisher(), events: TimelineEvent[] = []; publisher.onEvent(e => { if (e.type === 'agent-timeline')
    events.push(e); }); publisher.publishTimeline(commit, { source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 2) }, host); publisher.dispose(); return events; }
describe('Original captured transaction metadata', () => {
    it.each(['memory', 'file'] as const)('returns exact %s headers and original position through append/update/upsert/no-op', async (kind) => {
        const f = await fixture(kind), initial = await f.store.loadTimeline(sid), first = await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: item() });
        let reading: AgentTimelineSnapshot = { ...initial, sourceHostId: host };
        for (const mutation of [undefined, { type: 'update', agentSessionId: sid, itemId: item().id, updatedAt: _historyFixtureEpoch(0, 0, 2), content: 'Complete updated body' } as AgentTimelineMutation, { type: 'upsert', agentSessionId: sid, item: item(item().id, { createdAt: _historyFixtureEpoch(0, 0, 2), updatedAt: _historyFixtureEpoch(0, 0, 3), content: 'Complete settled body' }) } as AgentTimelineMutation]) {
            const commit = mutation ? await f.store.applyTimelineMutation(mutation) : first, event = emitted(commit)[0]!;
            expect(event).toBeDefined();
            const projected = applyAgentTimelineEvent(reading, event);
            expect(projected.gap).toBe(false);
            reading = projected.snapshot;
            const actual = await f.store.loadTimeline(sid);
            expect(reading).toEqual({ ...actual, sourceHostId: host });
            expect(commit.position.firstSequence).toBe(first.position.firstSequence);
            expect(commit.position.revision).toBe(conversationRevision(actual.items[0]));
            expect(commit.position.sequence).toBe(commit.stream.sequence);
        }
        const noOp = await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: reading.items[0]! });
        expect(noOp.changed).toBe(false);
        expect(emitted(noOp)).toEqual([]);
        const { positions: _positions, ...header } = reading.stream!;
        expect(noOp.stream).toEqual(header);
        first.stream.gaps.push({ code: 'OUTSIDE_CHANGE', message: 'Must not mutate the Store' });
        expect((await f.store.loadTimeline(sid)).stream?.gaps).toEqual([]);
        if (kind === 'file') {
            const reopened = new AgentMuxFileAgentSessionStore(f.path);
            expect(await reopened.loadTimeline(sid)).toEqual(await f.store.loadTimeline(sid));
        }
    });
    it('keeps independent numeric revision and sequence after original legacy handover', async () => { const f = await fixture('file', true), before = { ...await f.store.loadTimeline(sid), sourceHostId: host }, commit = await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: item() }); expect(commit.revision).toBe(32); expect(commit.stream.sequence).toBe(1); expect(applyAgentTimelineEvent(before, emitted(commit)[0]!).gap).toBe(false); });
    it('keeps the old reading and requests scoped repair for inconsistent metadata', async () => {
        const f = await fixture('memory'), first = await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: item() }), before = { ...await f.store.loadTimeline(sid), sourceHostId: host }, next = await f.store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: item().id, updatedAt: _historyFixtureEpoch(0, 0, 2), content: 'Changed complete body' }), event = emitted(next)[0]!;
        const wrong: TimelineEvent[] = [{ ...event, agentSessionId: 'foreign-session' }, { ...event, sourceHostId: 'foreign-host' }, { ...event, stream: { ...event.stream, epoch: 'foreign-epoch' } }, { ...event, stream: { ...event.stream, sequence: 9 } }, { ...event, stream: { ...event.stream, revision: 9 } }, { ...event, position: { ...event.position, id: 'foreign-record' } }, { ...event, position: { ...event.position, firstSequence: 2 } }, { ...event, position: { ...event.position, revision: first.position.revision } }, { ...event, stream: undefined } as unknown as TimelineEvent];
        for (const value of wrong) {
            const projected = applyAgentTimelineEvent(before, value);
            expect(projected.gap).toBe(true);
            expect(projected.snapshot).toBe(before);
        }
        expect(applyAgentTimelineEvent(before, emitted(first)[0]!).snapshot).toBe(before);
        expect(applyAgentTimelineEvent(applyAgentTimelineEvent(before, event).snapshot, event).gap).toBe(false);
    });
    it('does not reconstruct an evicted old upsert from a newer createdAt or invent an unread update target', async () => { const f = await fixture('memory'); await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: item() }); for (let n = 0; n < 200; n++)
        await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: item('peer-' + n) }); const before = { ...await f.store.loadTimeline(sid), sourceHostId: host }; expect(before.items.some(r => r.id === item().id)).toBe(false); const next = await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: item(item().id, { createdAt: _historyFixtureEpoch(0, 0, 2), updatedAt: _historyFixtureEpoch(0, 0, 4), content: 'Exact original settled body' }) }); expect(applyAgentTimelineEvent(before, emitted(next)[0]!).gap).toBe(true); });
    it('prunes only evicted positions and keeps all retained records in one accurate epoch', async () => { const f = await fixture('memory'); for (let n = 0; n < 200; n++)
        await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: item('peer-' + n) }); const before = { ...await f.store.loadTimeline(sid), sourceHostId: host }, commit = await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: item('last-original') }), projected = applyAgentTimelineEvent(before, emitted(commit)[0]!); expect(projected.gap).toBe(false); expect(projected.snapshot.stream?.positions.map(r => r.id)).toEqual(projected.snapshot.items.map(r => r.id)); expect(projected.snapshot.stream?.epoch).toBe(before.stream?.epoch); expect(projected.snapshot).toEqual({ ...await f.store.loadTimeline(sid), sourceHostId: host }); });
    it('actually carries the exact Client Session namespace through its persistence publisher without a lookup or no-op publication', async () => { const f = await fixture('memory'), client = new AgentMuxClient({ store: f.store }), events: TimelineEvent[] = []; client.onEvent(e => { if (e.type === 'agent-timeline')
        events.push(e); }); const original: AgentTimelineMutation = { type: 'append', agentSessionId: sid, item: item() }; try {
        const invoke = client as unknown as {
            persistAndPublishTimeline(m: AgentTimelineMutation, e: {
                source: 'native-hook';
                observedAt: number;
            }, hostId: string): Promise<void>;
        };
        await invoke.persistAndPublishTimeline(original, { source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 2) }, f.session.hostId);
        await invoke.persistAndPublishTimeline(original, { source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 2) }, f.session.hostId);
        expect(events).toHaveLength(1);
        expect(events[0]!.sourceHostId).toBe(f.session.hostId);
        expect(events[0]!.position.revision).toBe(conversationRevision(item()));
        const { positions: _positions, ...header } = (await client.sessionTimeline(sid)).stream!;
        expect(events[0]!.stream).toEqual(header);
    }
    finally {
        await client.dispose();
    } });
    it('preserves the exact metadata through the real RPC Hosted event transfer', async () => {
        const f = await fixture('memory'), client = new AgentMuxClient({ store: f.store }), service = new AgentMuxHostedRuntimeService(client, null, () => hostedTestOwner(client)), server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'selected-route', client }], hostedRuntime: () => service });
        const inner = client as unknown as {
            connected: boolean;
            kernel: {
                isConnected(): boolean;
                identity(): unknown;
                list(): Promise<unknown[]>;
            };
        };
        inner.connected = true;
        inner.kernel.isConnected = () => true;
        inner.kernel.identity = () => ({ daemonInstanceId: 'private-event-wire', protocolVersion: 1, buildIdentity: 'declared-read-transport' });
        inner.kernel.list = async () => [];
        await server.start();
        const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }), reader = new AgentMuxHostedTransferReader(), events: TimelineEvent[] = [];
        let subscription: Awaited<ReturnType<typeof rpc.subscribe>> | undefined;
        try {
            subscription = await rpc.subscribe('runtime.events', { fence: hostedTestFence, consumerId: 'original-reading-consumer' }, { onInitial() { }, onEvent(event) { if (event.type === 'snapshot') {
                    const value = reader.accept(event.data) as {
                        kind: string;
                        event?: AgentMuxClientEvent;
                    } | undefined;
                    if (value?.kind === 'event' && value.event?.type === 'agent-timeline')
                        events.push(value.event);
                } } });
            const mutation: AgentTimelineMutation = { type: 'append', agentSessionId: sid, item: item() }, invoke = client as unknown as {
                persistAndPublishTimeline(m: AgentTimelineMutation, e: {
                    source: 'native-hook';
                    observedAt: number;
                }, hostId: string): Promise<void>;
            };
            await invoke.persistAndPublishTimeline(mutation, { source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 2) }, f.session.hostId);
            await vi.waitFor(() => expect(events).toHaveLength(1));
            const snapshot = await client.sessionTimeline(sid);
            expect(events[0]!.sourceHostId).toBe(host);
            expect(events[0]!.position).toEqual(snapshot.stream!.positions[0]);
            const { positions: _positions, ...header } = snapshot.stream!;
            expect(events[0]!.stream).toEqual(header);
            expect(events[0]!.mutation).toEqual(mutation);
        }
        finally {
            await subscription?.dispose();
            await rpc.dispose();
            await server.stop();
            await service.dispose();
            await client.dispose();
        }
    });
});
