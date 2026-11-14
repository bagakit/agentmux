import { isDeepStrictEqual } from 'node:util';
import { AgentMuxError } from './errors.js';
import { AgentMuxSpatialStateStore } from './spatial-state.js';
import type { AgentMuxSpatialState } from './spatial-graph.js';
import { SpaceScopeIndex, applySpaceEdits, spaceScopeDelta, parseSpaceAuthorityParams, type SpaceAuthorityRef, type SpaceAuthoritySource, type SpaceApply, type SpaceSnapshot, type SpaceWatch, type SpaceWatchOpening, type SpaceChange } from './space-authority.js';
type Reader = {
    reference: SpaceAuthorityRef;
    source: SpaceAuthoritySource;
    current?: SpaceSnapshot | undefined;
    pending?: SpaceSnapshot | undefined;
    started: boolean;
    busy: boolean;
    closed: boolean;
    emit(event: {
        type: 'change';
        data: SpaceChange;
    } | {
        type: 'error';
        error: {
            code: string;
            message: string;
        };
    }): void | Promise<void>;
};
/** Ephemeral observation fanout only. The original SpatialStateStore remains the only writer. */
export class SpaceAuthorityOwner {
    private readonly readers = new Set<Reader>();
    private release: (() => void) | undefined;
    private index: SpaceScopeIndex | undefined;
    private readonly groups = new Map<string, Set<Reader>>();
    constructor(private readonly store: AgentMuxSpatialStateStore, private readonly source: () => Promise<SpaceAuthoritySource>) { }
    private async original(reference: SpaceAuthorityRef, signal?: AbortSignal): Promise<SpaceAuthoritySource> {
        signal?.throwIfAborted();
        const source = await this.source();
        signal?.throwIfAborted();
        if (source.runtimeId !== reference.runtimeId)
            throw new AgentMuxError('This Space belongs to another original Runtime. No local Space was substituted.', 'RUNTIME_OWNER_MISMATCH');
        return { runtimeId: source.runtimeId, ownerInstanceId: source.ownerInstanceId };
    }
    private snapshotAt(reference: SpaceAuthorityRef, source: SpaceAuthoritySource, index: SpaceScopeIndex): SpaceSnapshot {
        return { reference, source, revision: index.state.revision, scope: index.select(reference.spaceId) };
    }
    async snapshot(reference: SpaceAuthorityRef, signal?: AbortSignal): Promise<SpaceSnapshot> {
        const source = await this.original(reference, signal), state = await this.store.readForLayout();
        signal?.throwIfAborted();
        if (!state)
            throw new AgentMuxError('The original spatial document is unavailable. Retain the last confirmed Space and reread its owner.', 'SPATIAL_STATE_ABSENT');
        let index: SpaceScopeIndex;
        if (this.readers.size) {
            this.changed(state);
            index = this.index ?? new SpaceScopeIndex(state);
        }
        else
            index = new SpaceScopeIndex(state);
        return structuredClone(this.snapshotAt(reference, source, index));
    }
    async apply(value: SpaceApply, context: {
        signal?: AbortSignal;
        assertCurrent?(): void | Promise<void>;
    } = {}) {
        const input = parseSpaceAuthorityParams('space.apply', value), signal = context.signal;
        const source = await this.original(input.reference, signal);
        const state = await this.store.read();
        if (!state)
            throw new AgentMuxError('The original spatial document is unavailable; no replacement was written.', 'SPATIAL_STATE_ABSENT');
        const graph = applySpaceEdits(state, input);
        signal?.throwIfAborted();
        await context.assertCurrent?.();
        signal?.throwIfAborted();
        const saved = await this.store.commit({ expectedRevision: input.expectedRevision, graph,
            ...(Object.values(input.changes.remove ?? {}).some(ids => ids.length > 0) ? { allowEntityRemoval: true } : {}) });
        return { reference: input.reference, source, revision: saved.revision, diskDurability: 'confirmed' as const };
    }
    private changed(state: AgentMuxSpatialState): void {
        if (this.index && state.revision <= this.index.state.revision)
            return;
        const index = new SpaceScopeIndex(state), affected = this.index ? index.affected(this.index) : new Set(this.groups.keys());
        this.index = index;
        for (const spaceId of affected) {
            const readers = this.groups.get(spaceId);
            if (!readers?.size)
                continue;
            const scope = index.select(spaceId);
            for (const reader of readers) {
                if (reader.closed || reader.current && state.revision <= reader.current.revision)
                    continue;
                const previous = reader.pending ?? reader.current;
                if (previous && isDeepStrictEqual(previous.scope, scope))
                    continue;
                // One pending latest state per reader; slow consumers do not queue revisions.
                reader.pending = { reference: reader.reference, source: reader.source, revision: state.revision, scope };
                if (reader.started)
                    void this.flush(reader);
            }
        }
    }
    private async flush(reader: Reader): Promise<void> {
        if (reader.busy || reader.closed)
            return;
        reader.busy = true;
        try {
            while (reader.pending && reader.current && !reader.closed) {
                const next = reader.pending;
                reader.pending = undefined;
                if (isDeepStrictEqual(next.scope, reader.current.scope))
                    continue;
                const source = await this.original(reader.reference);
                if (source.ownerInstanceId !== reader.current.source.ownerInstanceId)
                    throw new AgentMuxError('The original Space observation owner changed; reread the same Runtime and Space.', 'RUNTIME_OWNER_CHANGED');
                if (reader.closed || !reader.current)
                    return;
                next.source = source;
                await reader.emit({ type: 'change', data: { reference: next.reference, source: next.source, revision: next.revision, fromRevision: reader.current.revision, delta: structuredClone(spaceScopeDelta(reader.current.scope, next.scope)) } });
                if (!reader.closed)
                    reader.current = next;
            }
        }
        catch (error) {
            this.failed(reader, error);
        }
        finally {
            reader.busy = false;
        }
    }
    private failed(reader: Reader, error: unknown): void {
        if (reader.closed)
            return;
        this.close(reader);
        const failure = error instanceof AgentMuxError ? error : new AgentMuxError(error instanceof Error ? error.message : String(error), 'SPATIAL_OBSERVATION_UNAVAILABLE');
        void Promise.resolve(reader.emit({ type: 'error', error: { code: failure.code, message: failure.message } })).catch(() => { });
    }
    private close(reader: Reader): void {
        reader.closed = true;
        reader.pending = undefined;
        reader.current = undefined;
        this.readers.delete(reader);
        const group = this.groups.get(reader.reference.spaceId);
        group?.delete(reader);
        if (!group?.size)
            this.groups.delete(reader.reference.spaceId);
        if (!this.readers.size) {
            this.release?.();
            this.release = undefined;
            this.index = undefined;
        }
    }
    async watch(input: SpaceWatch, emit: Reader['emit'], signal?: AbortSignal): Promise<{
        initial: SpaceWatchOpening;
        start(): void;
        dispose(): void;
    }> {
        const source = await this.original(input.reference, signal);
        const reader: Reader = { reference: input.reference, source, emit, started: false, busy: false, closed: false };
        this.readers.add(reader);
        const group = this.groups.get(input.reference.spaceId) ?? new Set<Reader>();
        group.add(reader);
        this.groups.set(input.reference.spaceId, group);
        if (!this.release)
            this.release = this.store.subscribe(state => this.changed(state), error => {
                for (const current of [...this.readers])
                    this.failed(current, error);
            });
        const dispose = () => { signal?.removeEventListener('abort', dispose); this.close(reader); };
        signal?.addEventListener('abort', dispose, { once: true });
        try {
            const initial = await this.snapshot(input.reference, signal);
            if (reader.closed)
                throw new AgentMuxError('The original Space reader was cancelled.', 'CONTROL_CANCELLED');
            const pending = reader.pending;
            reader.current = pending && pending.revision > initial.revision ? { ...pending, source } : initial;
            reader.pending = undefined;
            const snapshot = structuredClone(reader.current);
            return { initial: { snapshot, gap: input.after && (input.after.runtimeId !== snapshot.source.runtimeId || input.after.revision !== snapshot.revision)
                        ? { requested: input.after, availableRevision: snapshot.revision, reason: 'snapshot-required' } : null },
                start: () => { reader.started = true; void this.flush(reader); }, dispose };
        }
        catch (error) {
            dispose();
            throw error;
        }
    }
    dispose(): void {
        for (const reader of [...this.readers])
            this.close(reader);
    }
}
