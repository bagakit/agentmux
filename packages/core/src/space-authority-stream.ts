import { isDeepStrictEqual } from 'node:util';
import { AgentMuxError } from './errors.js';
import { rpcRecord } from './rpc-data.js';
import { mintObjectId } from './object-id.js';
import { hostedTransfer, AgentMuxHostedTransferReader, AGENTMUX_HOSTED_TRANSFER_CHUNK_BYTES, parseHostedTransferChunk } from './hosted-value.js';
import type { AgentMuxHostedTransferChunk } from './hosted-client-contract.js';
import type { AgentMuxRpcClient } from './public-rpc-client.js';
import { parseSpaceAuthorityRef, parseSpaceSnapshot, parseSpaceChange, applySpaceChange, type SpaceAuthorityRef, type SpaceAuthoritySource, type SpaceSnapshot, type SpaceChange, type SpaceWatch, type SpaceWatchOpening } from './space-authority.js';
export type SpaceStreamOpening = {
    reference: SpaceAuthorityRef;
    source: SpaceAuthoritySource;
    revision: number;
    gap: SpaceWatchOpening['gap'];
};
type Field = 'space' | 'zones' | 'tabs' | 'regions' | 'bindings' | 'remove.zones' | 'remove.tabs' | 'remove.regions';
type Begin = {
    kind: 'begin';
    mode: 'snapshot' | 'change';
    reference: SpaceAuthorityRef;
    source: SpaceAuthoritySource;
    revision: number;
    fromRevision?: number;
    counts: Partial<Record<Field, number>>;
};
type Row = Begin | {
    kind: 'part';
    field: Field;
    value: unknown;
} | {
    kind: 'complete';
};
const fields: readonly Field[] = ['space', 'zones', 'tabs', 'regions', 'bindings', 'remove.zones', 'remove.tabs', 'remove.regions'];
function fail(message: string): never { throw new AgentMuxError(message, 'CONTROL_PROTOCOL_ERROR'); }
export function spaceStreamOpening(snapshot: SpaceSnapshot, gap: SpaceWatchOpening['gap'] = null): SpaceStreamOpening {
    return { reference: snapshot.reference, source: snapshot.source, revision: snapshot.revision, gap };
}
export function parseSpaceStreamOpening(value: unknown, input: SpaceWatch): SpaceStreamOpening {
    const p = rpcRecord(value, ['reference', 'source', 'revision', 'gap'], 'CONTROL_PROTOCOL_ERROR'), reference = parseSpaceAuthorityRef(p.reference, 'CONTROL_PROTOCOL_ERROR');
    const source = rpcRecord(p.source, ['runtimeId', 'ownerInstanceId'], 'CONTROL_PROTOCOL_ERROR');
    if (!isDeepStrictEqual(reference, input.reference) || source.runtimeId !== reference.runtimeId || typeof source.ownerInstanceId !== 'string' || !source.ownerInstanceId || !Number.isSafeInteger(p.revision) || (p.revision as number) < 0)
        fail('The Space stream belongs to another original source.');
    if (p.gap !== null) {
        const gap = rpcRecord(p.gap, ['requested', 'availableRevision', 'reason'], 'CONTROL_PROTOCOL_ERROR');
        if (!input.after || !isDeepStrictEqual(gap.requested, input.after) || gap.availableRevision !== p.revision || gap.reason !== 'snapshot-required')
            fail('The Space opening does not match its original cursor.');
    }
    else if (input.after && (input.after.runtimeId !== source.runtimeId || input.after.revision !== p.revision))
        fail('The unavailable Space cursor requires an explicit new snapshot.');
    return value as SpaceStreamOpening;
}
/** Cumulative Space size is not a frame budget. Batch by the existing carrier's byte boundary. */
export function* spaceTransfer(value: SpaceSnapshot | SpaceChange): Generator<AgentMuxHostedTransferChunk> {
    const change = 'delta' in value, body = change ? value.delta : value.scope;
    const rows: Row[] = [];
    let bytes = 0;
    function* append(row: Row): Generator<AgentMuxHostedTransferChunk> {
        const size = Buffer.byteLength(JSON.stringify(row));
        if (rows.length && bytes + size > AGENTMUX_HOSTED_TRANSFER_CHUNK_BYTES) {
            yield* hostedTransfer(rows, mintObjectId());
            rows.length = 0;
            bytes = 0;
        }
        rows.push(row);
        bytes += size;
    }
    const counts: Begin['counts'] = {};
    for (const field of fields) {
        if (field.startsWith('remove.')) {
            const ids = change ? value.delta.remove?.[field.slice(7) as 'zones' | 'tabs' | 'regions'] : undefined;
            if (ids !== undefined)
                counts[field] = ids.length;
        }
        else if (Object.hasOwn(body, field))
            counts[field] = field === 'space' ? 1 : (body[field as 'zones' | 'tabs' | 'regions' | 'bindings']?.length ?? 0);
    }
    yield* append({ kind: 'begin', mode: change ? 'change' : 'snapshot', reference: value.reference, source: value.source, revision: value.revision, ...(change ? { fromRevision: value.fromRevision } : {}), counts });
    for (const field of fields) {
        if (!Object.hasOwn(counts, field))
            continue;
        if (field === 'space')
            yield* append({ kind: 'part', field, value: body.space });
        else {
            const list = field.startsWith('remove.') ? (value as SpaceChange).delta.remove![field.slice(7) as 'zones' | 'tabs' | 'regions']! : (body[field as 'zones' | 'tabs' | 'regions' | 'bindings'] ?? []);
            for (const item of list)
                yield* append({ kind: 'part', field, value: item });
        }
    }
    yield* append({ kind: 'complete' });
    if (rows.length)
        yield* hostedTransfer(rows, mintObjectId());
}
/** One in-flight transfer and this exact reader's current projection; no durable cache or new authority. */
export class SpaceTransferReader {
    private readonly carrier = new AgentMuxHostedTransferReader();
    private pending: {
        header: Begin;
        counts: Partial<Record<Field, number>>;
        body: Record<string, unknown>;
    } | undefined;
    private current: SpaceSnapshot | undefined;
    constructor(private readonly opening: SpaceStreamOpening) { }
    accept(value: unknown): Array<{
        snapshot: SpaceSnapshot;
        change?: SpaceChange;
    }> {
        const decoded = this.carrier.accept(parseHostedTransferChunk(value)), completed: Array<{
            snapshot: SpaceSnapshot;
            change?: SpaceChange;
        }> = [];
        if (decoded === undefined)
            return completed;
        if (!Array.isArray(decoded))
            fail('Space transfer batches must contain typed rows.');
        for (const value of decoded) {
            const row = rpcRecord(value, undefined, 'CONTROL_PROTOCOL_ERROR');
            if (row.kind === 'begin') {
                rpcRecord(row, ['kind', 'mode', 'reference', 'source', 'revision', 'fromRevision', 'counts'], 'CONTROL_PROTOCOL_ERROR');
                if (this.pending)
                    fail('The previous Space transfer is incomplete; retain its original snapshot.');
                const reference = parseSpaceAuthorityRef(row.reference, 'CONTROL_PROTOCOL_ERROR');
                if (!isDeepStrictEqual(reference, this.opening.reference) || !isDeepStrictEqual(row.source, this.opening.source) || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0)
                    fail('The Space transfer belongs to another source.');
                if (row.mode === 'snapshot') {
                    if (this.current || row.revision !== this.opening.revision || row.fromRevision !== undefined)
                        fail('The Space opening snapshot is not the original cut.');
                }
                else if (row.mode !== 'change' || !this.current || row.fromRevision !== this.current.revision || (row.revision as number) <= this.current.revision)
                    fail('The Space change does not continue the original snapshot.');
                const counts = rpcRecord(row.counts, fields, 'CONTROL_PROTOCOL_ERROR'), body: Record<string, unknown> = {};
                for (const [field, count] of Object.entries(counts)) {
                    if (!Number.isSafeInteger(count) || (count as number) < 0 || field === 'space' && count !== 1)
                        fail('Space transfer counts must describe exact original records.');
                    if (field.startsWith('remove.')) {
                        body.remove ??= {};
                        (body.remove as Record<string, unknown>)[field.slice(7)] = [];
                    }
                    else if (field !== 'space')
                        body[field] = [];
                }
                if (row.mode === 'snapshot' && (['space', 'zones', 'tabs', 'regions', 'bindings'].some(field => !Object.hasOwn(counts, field)) || Object.keys(counts).some(field => field.startsWith('remove.'))))
                    fail('A Space snapshot must describe its complete business scope.');
                this.pending = { header: row as unknown as Begin, counts: {}, body };
            }
            else if (row.kind === 'part') {
                rpcRecord(row, ['kind', 'field', 'value'], 'CONTROL_PROTOCOL_ERROR');
                const pending = this.pending, field = row.field as Field;
                if (!pending || !fields.includes(field) || !Object.hasOwn(pending.header.counts, field))
                    fail('A Space part has no original transfer header.');
                const count = (pending.counts[field] ?? 0) + 1;
                if (count > pending.header.counts[field]!)
                    fail('Space transfer repeats records.');
                pending.counts[field] = count;
                if (field === 'space')
                    pending.body.space = row.value;
                else if (field.startsWith('remove.')) {
                    if (typeof row.value !== 'string' || !row.value || row.value.includes('\0'))
                        fail('Space removal needs its original identity.');
                    ((pending.body.remove as Record<string, unknown>)[field.slice(7)] as unknown[]).push(row.value);
                }
                else
                    (pending.body[field] as unknown[]).push(row.value);
            }
            else if (row.kind === 'complete') {
                rpcRecord(row, ['kind'], 'CONTROL_PROTOCOL_ERROR');
                const pending = this.pending;
                if (!pending)
                    fail('Space completion has no original transfer.');
                for (const [field, count] of Object.entries(pending.header.counts))
                    if ((pending.counts[field as Field] ?? 0) !== count)
                        fail('The original Space transfer is incomplete.');
                const h = pending.header, metadata = { reference: h.reference, source: h.source, revision: h.revision };
                this.pending = undefined;
                if (h.mode === 'snapshot') {
                    this.current = parseSpaceSnapshot({ ...metadata, scope: pending.body }, this.opening.reference);
                    completed.push({ snapshot: this.current });
                }
                else {
                    const change = parseSpaceChange({ ...metadata, fromRevision: h.fromRevision, delta: pending.body }, this.opening.reference);
                    this.current = applySpaceChange(this.current!, change);
                    completed.push({ snapshot: this.current, change });
                }
            }
            else
                fail('Unknown Space transfer row.');
        }
        return completed;
    }
}
async function openSpace(rpc: Pick<AgentMuxRpcClient, 'subscribe'>, method: 'space.snapshot' | 'space.watch', input: SpaceWatch, options: {
    signal?: AbortSignal;
    onChange?(snapshot: SpaceSnapshot, change: SpaceChange): void;
    onError?(error: Error): void;
} = {}) {
    let reader: SpaceTransferReader | undefined, opening: SpaceStreamOpening | undefined, initial: SpaceSnapshot | undefined, closed = false;
    let resolve!: (snapshot: SpaceSnapshot) => void, reject!: (error: unknown) => void;
    const ready = new Promise<SpaceSnapshot>((yes, no) => { resolve = yes; reject = no; });
    void ready.catch(() => { });
    let subscription: Awaited<ReturnType<AgentMuxRpcClient['subscribe']>> | undefined;
    const failed = (error: unknown) => {
        if (closed)
            return;
        closed = true;
        const value = error instanceof Error ? error : new Error(String(error));
        const hadInitial = initial !== undefined;
        void subscription?.dispose();
        reader = undefined;
        initial = undefined;
        if (!hadInitial)
            reject(value);
        else
            options.onError?.(value);
    };
    subscription = await rpc.subscribe(method, input, {
        ...(options.signal ? { signal: options.signal } : {}), onInitial: value => { opening = value; reader = new SpaceTransferReader(value); },
        onEvent: event => {
            if (closed)
                return;
            if (event.type === 'snapshot') {
                try {
                    for (const observation of reader!.accept(event.data)) {
                        if (!initial) {
                            initial = observation.snapshot;
                            resolve(structuredClone(initial));
                        }
                        else if (observation.change)
                            options.onChange?.(structuredClone(observation.snapshot), structuredClone(observation.change));
                    }
                }
                catch (error) {
                    failed(error);
                    throw error;
                }
            }
            else if (event.type === 'error')
                failed(new AgentMuxError(event.error.message, event.error.code));
            else if (!initial || method === 'space.watch')
                failed(new AgentMuxError('The Space stream ended; retain the original snapshot and reopen its owner.', 'SPACE_OBSERVATION_GAP'));
        },
        onEnd: error => {
            if (error)
                failed(error);
            else if ((!initial || method === 'space.watch') && !closed)
                failed(new AgentMuxError('The original Space stream ended. Retain its reference and reopen it.', 'CONTROL_UNAVAILABLE'));
        }
    });
    try {
        return { initial: await ready, gap: opening!.gap, dispose: async () => { closed = true; await subscription!.dispose(); reader = undefined; initial = undefined; } };
    }
    catch (error) {
        closed = true;
        await subscription!.dispose();
        throw error;
    }
}
export async function readSpaceSnapshot(rpc: Pick<AgentMuxRpcClient, 'subscribe'>, reference: SpaceAuthorityRef, options: {
    signal?: AbortSignal;
} = {}): Promise<SpaceSnapshot> {
    const reader = await openSpace(rpc, 'space.snapshot', { reference }, options);
    try {
        return reader.initial;
    }
    finally {
        await reader.dispose();
    }
}
export async function observeSpace(rpc: Pick<AgentMuxRpcClient, 'subscribe'>, input: SpaceWatch, options: {
    signal?: AbortSignal;
    onChange?(snapshot: SpaceSnapshot, change: SpaceChange): void;
    onError?(error: Error): void;
} = {}) {
    return await openSpace(rpc, 'space.watch', input, options);
}
