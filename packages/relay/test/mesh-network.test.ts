import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createClientChannel, exportPublicKey, generateKeyPair, type Transport } from '../src/e2ee.js';
import { createRelayGateway, createRelayMeshIdentity, hashPublisherToken, startRelayGateway, type RelayMeshConfiguration } from '../src/gateway.js';
import { startRelayTransport, type RelayLogger } from '../src/server-transport.js';
import { buildRelayWebSocketUrl } from '../src/daemon-endpoints.js';
import { meshCanonical, signMesh, type RelayMeshIdentity, type RelayMeshRecord } from '../src/mesh-protocol.js';
const cleanup: Array<() => void | Promise<void>> = [];
const facts: unknown[] = [], privateRoots: string[] = [], assemblyPids: number[] = [];
afterEach(async ({ task }) => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) try { await close(); } catch (error) { errors.push(error); }
  const roots = await Promise.all(privateRoots.splice(0).map(async path => ({ path, absent: await access(path).then(() => false, () => true) })));
  const processes = assemblyPids.splice(0).map(pid => { let exited = false; try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') exited = true; else throw error; } return { pid, exited }; });
  if (roots.some(root => !root.absent) || processes.some(item => !item.exited)) errors.push(Error('Recorded private Mesh assembly resources remain'));
  if (process.env.RELAY_MESH_CONSUMER_REPORT) await appendFile(process.env.RELAY_MESH_CONSUMER_REPORT, JSON.stringify({ test: task.name, facts: facts.splice(0), cleanup: { roots, processes, errors: errors.map(String) } }) + '\n');
  else facts.splice(0);
  if (errors.length) throw new AggregateError(errors, 'Mesh private cleanup');
});
const logger: RelayLogger = { child: () => logger, info() { }, warn() { }, debug() { } };
const keys = () => ({ ...createRelayMeshIdentity(), epoch: 1 });
async function topology(cEpoch = 1) {
  const identities = [keys(), keys(), keys()];
  identities[2]!.epoch = cEpoch;
  const members = identities.map(({ peerId, publicKey }) => ({ peerId, publicKey }));
  const configs: RelayMeshConfiguration[] = identities.map(identity => ({ networkId: 'private-three-gateway', identity, members, peers: [] }));
  configs[1]!.peers = [{ peerId: identities[0]!.peerId, endpoints: [] }, { peerId: identities[2]!.peerId, endpoints: [] }];
  const bServer = createHttpServer((_request, response) => response.end('original borrowed HTTP'));
  const runtimeB = createRelayGateway({ publishers: [{ serverId: 'beta', tokenHash: hashPublisherToken('beta-private') }], mesh: configs[1] });
  runtimeB.attach(bServer);
  await new Promise<void>(yes => bServer.listen(0, '127.0.0.1', yes));
  const bAddress = bServer.address(); if (!bAddress || typeof bAddress === 'string') throw Error('Private B listener missing');
  const b = { ...runtimeB, port: bAddress.port };
  cleanup.push(async () => { await b.stop(); bServer.closeAllConnections(); await new Promise<void>(yes => bServer.close(() => yes())); });
  const bEndpoint = { endpoint: '127.0.0.1:' + b.port, useTls: false };
  configs[0]!.peers = [{ peerId: identities[1]!.peerId, endpoints: [bEndpoint] }];
  configs[2]!.peers = [{ peerId: identities[1]!.peerId, endpoints: [bEndpoint] }];
  const a = await startRelayGateway({ port: 0, publishers: [], mesh: configs[0] });
  cleanup.push(() => a.stop());
  const c = await startRelayGateway({ port: 0, publishers: [{ serverId: 'alpha', tokenHash: hashPublisherToken('alpha-private') }], mesh: configs[2] });
  cleanup.push(() => c.stop());
  return { a, b, c, bServer, identities, configs, members };
}
async function publisher(port: number, serverId: string, reply: (text: string) => string = text => text) {
  const daemon = generateKeyPair(), received: string[] = [], states: string[] = [];
  const controller = startRelayTransport({ logger, serverId, relayEndpoint: '127.0.0.1:' + port, relayUseTls: false, daemonKeyPair: daemon,
    createWebSocket: url => new WebSocket(url, { headers: { authorization: 'Bearer ' + serverId + '-private' } }),
    onState: state => states.push(state), attachSocket: async (ws, metadata) => {
      expect(metadata?.peerPublicKeyB64).toBeTruthy();
      ws.on('message', async (value) => { const text = typeof value === 'string' ? value : new TextDecoder().decode(value as ArrayBuffer); received.push(text); await ws.send(reply(text)); });
    } });
  cleanup.push(() => controller.stop());
  await vi.waitFor(() => expect(states).toContain('connected'));
  return { daemon, received, controller };
}
async function client(port: number, serverId: string, publicKey: Uint8Array) {
  return encryptedSocket(new WebSocket(buildRelayWebSocketUrl({ endpoint: '127.0.0.1:' + port, useTls: false, serverId, role: 'client' })), publicKey);
}
async function encryptedSocket(ws: WebSocket, publicKey: Uint8Array) {
  const messages: string[] = [];
  cleanup.push(() => ws.terminate());
  ws.on('error', () => { });
  const transport: Transport = { send: data => ws.send(data), close: (code, reason) => ws.close(code === 1000 || code && code >= 3000 && code <= 4999 ? code : 4001, reason), onmessage: null, onclose: null, onerror: null };
  ws.on('message', (data, binary) => transport.onmessage?.({ data: binary ? Uint8Array.from(data as Buffer).buffer : data.toString(), isBinary: binary }));
  ws.on('close', (code, reason) => transport.onclose?.(code, reason.toString()));
  await once(ws, 'open');
  let opened = false;
  const channel = await createClientChannel(transport, exportPublicKey(publicKey), { onopen: () => { opened = true; }, onmessage: value => messages.push(typeof value === 'string' ? value : new TextDecoder().decode(value)), onerror() { }, onclose() { } });
  cleanup.push(() => channel.close());
  await vi.waitFor(() => expect(opened).toBe(true), { timeout: 10000 });
  return { ws, channel, messages };
}
async function rawPeer(port: number, identity: RelayMeshIdentity, networkId = 'private-three-gateway', replayedProof?: string) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/mesh', { headers: { 'x-agentmux-mesh-peer': identity.peerId } });
  cleanup.push(() => ws.terminate());
  ws.on('error', () => { });
  const local = { type: 'hello', networkId, peerId: identity.peerId, epoch: identity.epoch, nonce: randomBytes(24).toString('base64url') };
  let remote: any, proof = '', connectionId = '';
  const frames: any[] = [];
  ws.on('message', data => {
    const frame = JSON.parse(data.toString());
    frames.push(frame);
    if (frame.type === 'hello') {
      remote = frame;
      const body = { purpose: 'agentmux-relay-mesh-peer/1', hellos: [local, remote].sort((a, b) => a.peerId.localeCompare(b.peerId)) };
      proof = signMesh(body, identity);
      connectionId = createHash('sha256').update(meshCanonical(body)).digest('hex');
      ws.send(JSON.stringify({ type: 'proof', signature: replayedProof ?? proof }));
    }
  });
  ws.once('open', () => ws.send(JSON.stringify(local)));
  await once(ws, 'open');
  return { ws, frames, get remote() { return remote; }, get proof() { return proof; }, get connectionId() { return connectionId; },
    record(body: Omit<RelayMeshRecord, 'signature'>, signer = identity) { ws.send(JSON.stringify({ type: 'record', record: { ...body, signature: signMesh(body, signer) } })); } };
}
async function addRawMember(t: Awaited<ReturnType<typeof topology>>, identity: RelayMeshIdentity) {
  const member = { peerId: identity.peerId, publicKey: identity.publicKey }, members = [...t.members, member];
  await t.b.configure({ publishers: [{ serverId: 'beta', tokenHash: hashPublisherToken('beta-private') }], mesh: { ...t.configs[1]!, members } });
  await t.c.configure({ publishers: [{ serverId: 'alpha', tokenHash: hashPublisherToken('alpha-private') }], mesh: { ...t.configs[2]!, members } });
  await t.a.configure({ publishers: [], mesh: { ...t.configs[0]!, members, peers: [...t.configs[0]!.peers, { peerId: identity.peerId, endpoints: [] }] } });
}
function rawRecord(peer: Awaited<ReturnType<typeof rawPeer>>, identity: RelayMeshIdentity, revision: number): Omit<RelayMeshRecord, 'signature'> {
  return { version: 1, networkId: 'private-three-gateway', originPeerId: identity.peerId, epoch: identity.epoch, revision,
    neighbors: [{ peerId: peer.remote.peerId, peerEpoch: peer.remote.epoch, connectionId: peer.connectionId, rttMs: 10 }], publishers: [], advertisedIngress: [] };
}
it('propagates signed topology and carries original E2EE through three gateways with reverse-only adjacent data dialing', async () => {
  const t = await topology(), alpha = await publisher(t.c.port, 'alpha'), beta = await publisher(t.b.port, 'beta');
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.path).toEqual(t.identities.map(i => i.peerId)), { timeout: 10000 });
  const original = await client(t.a.port, 'alpha', alpha.daemon.publicKey), other = await client(t.a.port, 'beta', beta.daemon.publicKey);
  await original.channel.send('opaque-original-alpha');
  await other.channel.send('opaque-original-beta');
  await vi.waitFor(() => { expect(original.messages).toEqual(['opaque-original-alpha']); expect(other.messages).toEqual(['opaque-original-beta']); });
  expect(t.b.inspectMesh().circuits.find(c => c.serverId === 'alpha')?.path).toHaveLength(3);
  expect(t.a.inspectMesh().records).toHaveLength(3);
  // Both A and C dial B; B cannot initiate a TCP connection to C from its config.
  expect(t.configs[1]!.peers.every(p => p.endpoints.length === 0)).toBe(true);
  await alpha.controller.stop();
  await vi.waitFor(() => expect(original.ws.readyState).toBe(WebSocket.CLOSED));
  await other.channel.send('beta-continues');
  await vi.waitFor(() => expect(other.messages.at(-1)).toBe('beta-continues'));
  expect(alpha.received).toEqual(['opaque-original-alpha']);
  expect(beta.received).toEqual(['opaque-original-beta', 'beta-continues']);
  facts.push({ case: 'three-gateway-chain', gateways: t.identities.map(i => ({ peerId: i.peerId, publicKey: i.publicKey, epoch: i.epoch })), alphaPath: t.identities.map(i => i.peerId), reverseTcpRequired: false, alphaAccepted: alpha.received.length, betaAccepted: beta.received.length });
}, 30000);
it('freezes existing circuits while new circuits adopt an alternate path and isolates explicit peer revocation', async () => {
  const t = await topology(), alpha = await publisher(t.c.port, 'alpha'), beta = await publisher(t.b.port, 'beta');
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.hops).toBe(2));
  const original = await client(t.a.port, 'alpha', alpha.daemon.publicKey), other = await client(t.a.port, 'beta', beta.daemon.publicKey);
  await original.channel.send('old-path-first');
  await vi.waitFor(() => expect(original.messages).toEqual(['old-path-first']));
  const frozen = t.a.inspectMesh().circuits.find(c => c.serverId === 'alpha')!;
  const direct = { endpoint: '127.0.0.1:' + t.c.port, useTls: false };
  const nextC = { ...t.configs[2]!, peers: [...t.configs[2]!.peers, { peerId: t.identities[0]!.peerId, endpoints: [] }] };
  const nextA = { ...t.configs[0]!, peers: [...t.configs[0]!.peers, { peerId: t.identities[2]!.peerId, endpoints: [direct] }] };
  await t.c.configure({ publishers: [{ serverId: 'alpha', tokenHash: hashPublisherToken('alpha-private') }], mesh: nextC });
  await t.a.configure({ publishers: [], mesh: nextA });
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.hops).toBe(1));
  expect(t.a.inspectMesh().circuits.find(c => c.circuitId === frozen.circuitId)?.path).toEqual(frozen.path);
  await original.channel.send('old-path-still-original');
  await vi.waitFor(() => expect(original.messages.at(-1)).toBe('old-path-still-original'));
  const newer = await client(t.a.port, 'alpha', alpha.daemon.publicKey);
  await newer.channel.send('new-direct-path');
  await vi.waitFor(() => expect(newer.messages).toEqual(['new-direct-path']));
  expect(t.a.inspectMesh().circuits.filter(c => c.serverId === 'alpha').map(c => c.path.length).sort()).toEqual([2, 3]);
  await t.a.configure({ publishers: [], mesh: t.configs[0] });
  await vi.waitFor(() => expect(newer.ws.readyState).toBe(WebSocket.CLOSED));
  expect(original.ws.readyState).toBe(WebSocket.OPEN);
  await original.channel.send('old-path-after-direct-revoke');
  await other.channel.send('independent-beta');
  await vi.waitFor(() => { expect(original.messages.at(-1)).toBe('old-path-after-direct-revoke'); expect(other.messages).toEqual(['independent-beta']); });
  expect(alpha.received).toEqual(['old-path-first', 'old-path-still-original', 'new-direct-path', 'old-path-after-direct-revoke']);
  expect(beta.received).toEqual(['independent-beta']);
  facts.push({ case: 'alternate-and-revoke', frozenCircuit: frozen, adoptedDirectPath: [t.identities[0]!.peerId, t.identities[2]!.peerId], alphaAccepted: alpha.received.length, betaAccepted: beta.received.length });
}, 30000);
it('revokes a remote member circuit while preserving the unchanged adjacent peer and its old and new E2EE consumers', async () => {
  const t = await topology(), alpha = await publisher(t.c.port, 'alpha'), beta = await publisher(t.b.port, 'beta');
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.hops).toBe(2));
  const original = await client(t.a.port, 'alpha', alpha.daemon.publicKey), healthy = await client(t.a.port, 'beta', beta.daemon.publicKey);
  await original.channel.send('original-remote-before-revoke');
  await healthy.channel.send('adjacent-before-revoke');
  await vi.waitFor(() => { expect(original.messages).toEqual(['original-remote-before-revoke']); expect(healthy.messages).toEqual(['adjacent-before-revoke']); });
  const adjacent = t.a.inspectMesh().peers.find(peer => peer.peerId === t.identities[1]!.peerId)!;
  expect(adjacent.state).toBe('connected');
  await t.a.configure({ publishers: [], mesh: { ...t.configs[0]!, members: t.members.slice(0, 2) } });
  await vi.waitFor(() => expect(original.ws.readyState).toBe(WebSocket.CLOSED));
  // B still knows C. Its valid signed record and forwarded C record must neither
  // re-admit C at A nor tear down the unchanged authenticated A-B connection.
  await t.b.configure({ publishers: [{ serverId: 'beta', tokenHash: hashPublisherToken('beta-private') }], mesh: t.configs[1] });
  await t.c.configure({ publishers: [{ serverId: 'alpha', tokenHash: hashPublisherToken('alpha-private') }], mesh: t.configs[2] });
  const revision = t.b.inspectMesh().records.find(record => record.originPeerId === t.identities[1]!.peerId)!.revision;
  await vi.waitFor(() => expect(t.a.inspectMesh().records.find(record => record.originPeerId === t.identities[1]!.peerId)?.revision).toBeGreaterThanOrEqual(revision));
  expect(t.a.inspectMesh().peers.find(peer => peer.peerId === t.identities[1]!.peerId)).toMatchObject({ state: 'connected', connectionId: adjacent.connectionId });
  expect(t.a.inspectMesh().records.some(record => record.originPeerId === t.identities[2]!.peerId)).toBe(false);
  expect(t.a.resolvePublisher('alpha')).toBeNull();
  await healthy.channel.send('adjacent-after-remote-revoke');
  const fresh = await client(t.a.port, 'beta', beta.daemon.publicKey);
  await fresh.channel.send('new-adjacent-after-remote-revoke');
  await vi.waitFor(() => { expect(healthy.messages.at(-1)).toBe('adjacent-after-remote-revoke'); expect(fresh.messages).toEqual(['new-adjacent-after-remote-revoke']); });
  expect(beta.received).toEqual(['adjacent-before-revoke', 'adjacent-after-remote-revoke', 'new-adjacent-after-remote-revoke']);
  expect(alpha.received).toEqual(['original-remote-before-revoke']);
  facts.push({ case: 'remote-member-revoke', revokedPeerId: t.identities[2]!.peerId, adjacentPeerId: adjacent.peerId, retainedConnectionId: adjacent.connectionId, acceptedAdjacentRevision: revision, remoteRouteAbsent: t.a.resolvePublisher('alpha') === null, betaAccepted: beta.received.length });
}, 30000);
it('scopes a paused multihop large reader while another publisher works and allows cumulative valid output', async () => {
  const t = await topology(), large = 'R'.repeat(20 * 1024 * 1024);
  const alpha = await publisher(t.c.port, 'alpha', () => large), beta = await publisher(t.b.port, 'beta');
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.hops).toBe(2));
  const slow = await client(t.a.port, 'alpha', alpha.daemon.publicKey), healthy = await client(t.a.port, 'beta', beta.daemon.publicKey);
  slow.ws.pause();
  await slow.channel.send('large-one');
  await healthy.channel.send('healthy-during-large-reader');
  await vi.waitFor(() => expect(healthy.messages).toEqual(['healthy-during-large-reader']));
  slow.ws.resume();
  await vi.waitFor(() => expect(slow.messages[0]?.length).toBe(large.length), { timeout: 15000 });
  await slow.channel.send('large-two');
  await vi.waitFor(() => expect(slow.messages[1]).toBe(large), { timeout: 15000 });
  expect(alpha.received).toEqual(['large-one', 'large-two']);
  expect(beta.received).toEqual(['healthy-during-large-reader']);
  facts.push({ case: 'large-reader', bytesPerReply: large.length, cumulativeValidReplyBytes: slow.messages.reduce((sum, value) => sum + value.length, 0), healthyPeerAccepted: beta.received.length });
}, 45000);
it.each(['revoke', 'stop'])('cancels the original held data upgrade before %s can be followed by late circuit activation', async mode => {
  const t = await topology(), alpha = await publisher(t.c.port, 'alpha'), beta = await publisher(t.b.port, 'beta');
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.hops).toBe(2));
  const healthy = await client(t.b.port, 'beta', beta.daemon.publicKey);
  let release: (() => void) | undefined;
  t.bServer.prependListener('upgrade', (request, socket) => {
    if (request.url !== '/mesh/data' || request.headers['x-agentmux-mesh-peer'] !== t.identities[2]!.peerId || release) return;
    const write = socket.write, buffered: unknown[][] = [];
    socket.write = ((...args: unknown[]) => { buffered.push(args); return true; }) as typeof socket.write;
    release = () => { socket.write = write; if (!socket.destroyed) for (const args of buffered) Reflect.apply(write, socket, args); };
  });
  const pending = new WebSocket(buildRelayWebSocketUrl({ endpoint: '127.0.0.1:' + t.a.port, useTls: false, serverId: 'alpha', role: 'client' }));
  pending.on('error', () => {}); cleanup.push(() => pending.terminate()); await once(pending, 'open');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(t.c.inspectMesh().circuits).toHaveLength(0);
  if (mode === 'revoke') await t.c.configure({ publishers: [{ serverId: 'alpha', tokenHash: hashPublisherToken('alpha-private') }], mesh: { ...t.configs[2]!, peers: [] } });
  else await t.c.stop();
  release!();
  await vi.waitFor(() => expect(pending.readyState).toBe(WebSocket.CLOSED));
  expect(t.c.inspectMesh().circuits).toHaveLength(0);
  await healthy.channel.send('independent-after-late-' + mode);
  await vi.waitFor(() => expect(healthy.messages).toEqual(['independent-after-late-' + mode]));
  expect(await (await fetch('http://127.0.0.1:' + t.b.port + '/')).text()).toBe('original borrowed HTTP');
  if (mode === 'revoke') {
    const localOriginal = await client(t.c.port, 'alpha', alpha.daemon.publicKey);
    await localOriginal.channel.send('original-local-publisher-still-usable');
    await vi.waitFor(() => expect(localOriginal.messages).toEqual(['original-local-publisher-still-usable']));
  }
}, 30000);
it('atomically claims pending circuit identity and consumes each data reservation only once', async () => {
  const t = await topology(), alpha = await publisher(t.c.port, 'alpha'), identity = keys();
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.hops).toBe(2));
  await addRawMember(t, identity);
  const peer = await rawPeer(t.a.port, identity);
  await vi.waitFor(() => expect(peer.frames.some(frame => frame.type === 'record')).toBe(true));
  peer.record(rawRecord(peer, identity, 1));
  await vi.waitFor(() => expect(t.a.inspectMesh().records.some(r => r.originPeerId === identity.peerId)).toBe(true));
  const selected = t.a.resolvePublisher('alpha')!, path = [identity.peerId, ...selected.path], route = { ...selected, path, hops: path.length - 1 };
  const records = t.a.inspectMesh().records;
  const edges = path.slice(1).map((to, index) => {
    const a = records.find(r => r.originPeerId === path[index])!, b = records.find(r => r.originPeerId === to)!;
    return { connectionId: a.neighbors.find(n => n.peerId === to)!.connectionId, sourceEpoch: a.epoch, targetEpoch: b.epoch };
  });
  const circuitId = 'same-original-circuit', open = { circuitId, route, edges, index: 1,
    signature: signMesh({ purpose: 'agentmux-relay-mesh-circuit/1', networkId: 'private-three-gateway', circuitId, route, edges }, identity) };
  peer.ws.send(JSON.stringify({ type: 'open', requestId: 'first-reservation', open }));
  peer.ws.send(JSON.stringify({ type: 'open', requestId: 'duplicate-reservation', open }));
  await vi.waitFor(() => expect(peer.frames.some(frame => frame.type === 'failed' && frame.requestId === 'duplicate-reservation')).toBe(true));
  const reserved = peer.frames.find(frame => frame.type === 'reserved' && frame.requestId === 'first-reservation');
  expect(reserved?.token).toBeTypeOf('string');
  const original = await encryptedSocket(new WebSocket('ws://127.0.0.1:' + t.a.port + '/mesh/data', { headers: { authorization: 'Bearer ' + reserved.token, 'x-agentmux-mesh-peer': identity.peerId } }), alpha.daemon.publicKey);
  await original.channel.send('first-circuit-remains-original');
  await vi.waitFor(() => expect(original.messages).toEqual(['first-circuit-remains-original']));
  const repeated = new WebSocket('ws://127.0.0.1:' + t.a.port + '/mesh/data', { headers: { authorization: 'Bearer ' + reserved.token, 'x-agentmux-mesh-peer': identity.peerId } });
  repeated.on('error', () => {}); cleanup.push(() => repeated.terminate());
  const refused = await new Promise<number>((yes, no) => { repeated.once('unexpected-response', (_request, response) => { response.resume(); repeated.terminate(); yes(response.statusCode!); }); repeated.once('open', () => no(Error('Repeated circuit token opened'))); });
  expect(refused).toBe(403);
  expect(t.a.inspectMesh().circuits.filter(c => c.circuitId === circuitId)).toHaveLength(1);
  await original.channel.send('same-circuit-after-duplicate-refusal');
  await vi.waitFor(() => expect(original.messages.at(-1)).toBe('same-circuit-after-duplicate-refusal'));
}, 30000);
it('charges a frozen path only to its actual local adjacency when a new direct peer appears', async () => {
  const t = await topology();
  await publisher(t.c.port, 'alpha');
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.hops).toBe(2));
  const old = Array.from({ length: 128 }, () => {
    const ws = new WebSocket(buildRelayWebSocketUrl({ endpoint: '127.0.0.1:' + t.a.port, useTls: false, serverId: 'alpha', role: 'client' }));
    ws.on('error', () => {}); cleanup.push(() => ws.terminate()); return ws;
  });
  await vi.waitFor(() => expect(t.c.inspectMesh().circuits.filter(c => c.serverId === 'alpha')).toHaveLength(128), { timeout: 15000 });
  const nextC = { ...t.configs[2]!, peers: [...t.configs[2]!.peers, { peerId: t.identities[0]!.peerId, endpoints: [] }] };
  await t.c.configure({ publishers: [
    { serverId: 'alpha', tokenHash: hashPublisherToken('alpha-private') }, { serverId: 'gamma', tokenHash: hashPublisherToken('gamma-private') },
  ], mesh: nextC });
  await t.a.configure({ publishers: [], mesh: { ...t.configs[0]!, peers: [...t.configs[0]!.peers, { peerId: t.identities[2]!.peerId, endpoints: [{ endpoint: '127.0.0.1:' + t.c.port, useTls: false }] }] } });
  const gamma = await publisher(t.c.port, 'gamma');
  await vi.waitFor(() => expect(t.a.resolvePublisher('gamma')?.hops).toBe(1));
  const direct = await client(t.a.port, 'gamma', gamma.daemon.publicKey);
  await direct.channel.send('new-adjacency-has-its-own-budget');
  await vi.waitFor(() => expect(direct.messages).toEqual(['new-adjacency-has-its-own-budget']));
  expect(old.every(ws => ws.readyState === WebSocket.OPEN)).toBe(true);
  expect(t.c.inspectMesh().circuits.filter(c => c.serverId === 'alpha').every(c => c.path.length === 3)).toBe(true);
}, 45000);
it('rejects a forged origin record and stale revision without disturbing a healthy encrypted circuit', async () => {
  const t = await topology(2), alpha = await publisher(t.c.port, 'alpha'), malicious = keys();
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.hops).toBe(2));
  const healthy = await client(t.a.port, 'alpha', alpha.daemon.publicKey);
  await addRawMember(t, malicious);
  const peer = await rawPeer(t.a.port, malicious);
  await vi.waitFor(() => expect(peer.frames.some(f => f.type === 'record')).toBe(true));
  const original = rawRecord(peer, malicious, 10);
  const currentC = t.a.inspectMesh().records.find(record => record.originPeerId === t.identities[2]!.peerId)!;
  const { signature: _signature, ...currentBody } = currentC;
  peer.record({ ...currentBody, epoch: 1, revision: 999999 }, t.identities[2]);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(t.a.inspectMesh().records.find(record => record.originPeerId === currentC.originPeerId)?.epoch).toBe(2);
  peer.record(original);
  await vi.waitFor(() => expect(t.a.inspectMesh().records.find(r => r.originPeerId === malicious.peerId)?.revision).toBe(10));
  peer.record({ ...original, revision: 9, publishers: [{ serverId: 'rollback-publisher', generation: 'forged' }] });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(t.a.resolvePublisher('rollback-publisher')).toBeNull();
  expect(t.a.inspectMesh().records.find(r => r.originPeerId === malicious.peerId)?.revision).toBe(10);
  peer.record({ ...original, revision: 11, neighbors: [{ ...original.neighbors[0]!, connectionId: 'nonreciprocal-edge' }], publishers: [{ serverId: 'nonreciprocal-publisher', generation: 'one-sided' }] });
  await vi.waitFor(() => expect(t.a.inspectMesh().records.find(r => r.originPeerId === malicious.peerId)?.revision).toBe(11));
  expect(t.a.resolvePublisher('nonreciprocal-publisher')).toBeNull();
  const c = t.identities[2]!, edge = 'forged-edge';
  peer.record({ ...original, revision: 12, neighbors: [...original.neighbors, { peerId: c.peerId, peerEpoch: c.epoch, connectionId: edge, rttMs: 1 }] });
  const forged = { ...original, originPeerId: c.peerId, epoch: c.epoch, revision: 99999, neighbors: [{ peerId: malicious.peerId, peerEpoch: malicious.epoch, connectionId: edge, rttMs: 1 }], publishers: [{ serverId: 'forged-publisher', generation: 'forged' }] };
  peer.record(forged);
  await vi.waitFor(() => expect(peer.ws.readyState).toBe(WebSocket.CLOSED));
  expect(t.a.resolvePublisher('forged-publisher')).toBeNull();
  await healthy.channel.send('healthy-after-malformed-advertisement');
  await vi.waitFor(() => expect(healthy.messages).toEqual(['healthy-after-malformed-advertisement']));
}, 30000);
it('rejects replayed peer proofs, wrong realms and signed loop or wrong-target circuits on their exact peer', async () => {
  const t = await topology(), alpha = await publisher(t.c.port, 'alpha'), identity = keys();
  await vi.waitFor(() => expect(t.a.resolvePublisher('alpha')?.hops).toBe(2));
  const healthy = await client(t.a.port, 'alpha', alpha.daemon.publicKey);
  await addRawMember(t, identity);
  const original = await rawPeer(t.a.port, identity);
  await vi.waitFor(() => expect(original.frames.some(f => f.type === 'record')).toBe(true));
  const oldProof = original.proof;
  original.ws.close();
  await once(original.ws, 'close');
  const replay = await rawPeer(t.a.port, identity, 'private-three-gateway', oldProof);
  await vi.waitFor(() => expect(replay.ws.readyState).toBe(WebSocket.CLOSED));
  const wrongRealm = await rawPeer(t.a.port, identity, 'another-network');
  await vi.waitFor(() => expect(wrongRealm.ws.readyState).toBe(WebSocket.CLOSED));
  let revision = 0;
  for (const kind of ['loop', 'target', 'signature', 'generation']) {
    const peer = await rawPeer(t.a.port, identity);
    await vi.waitFor(() => expect(peer.frames.some(f => f.type === 'record')).toBe(true));
    peer.record(rawRecord(peer, identity, ++revision));
    await vi.waitFor(() => expect(t.a.inspectMesh().records.find(r => r.originPeerId === identity.peerId)?.neighbors[0]?.connectionId).toBe(peer.connectionId));
    const route = t.a.resolvePublisher('alpha')!;
    const path = kind === 'loop' ? [identity.peerId, ...route.path.slice(0, 1), identity.peerId, ...route.path.slice(1)] : kind === 'signature' || kind === 'generation' ? [identity.peerId, ...route.path] : [identity.peerId, t.identities[0]!.peerId];
    const candidate = { ...route, path, hops: path.length - 1, ...(kind === 'target' ? { originPeerId: t.identities[0]!.peerId } : {}) };
    const records = t.a.inspectMesh().records;
    const edges = path.slice(1).map((toId, index) => {
      const from = records.find(r => r.originPeerId === path[index]), to = records.find(r => r.originPeerId === toId);
      return { connectionId: from?.neighbors.find(n => n.peerId === toId)?.connectionId ?? 'invalid-edge', sourceEpoch: from?.epoch ?? 1, targetEpoch: to?.epoch ?? 1 };
    });
    if (kind === 'generation') edges[0]!.connectionId = 'another-control-generation';
    const circuitId = 'invalid-' + kind, signature = signMesh({ purpose: 'agentmux-relay-mesh-circuit/1', networkId: 'private-three-gateway', circuitId, route: candidate, edges }, kind === 'signature' ? keys() : identity);
    peer.ws.send(JSON.stringify({ type: 'open', requestId: 'invalid-' + kind, open: { circuitId, route: candidate, edges, index: 1, signature } }));
    await vi.waitFor(() => expect(peer.frames.some(frame => frame.type === 'failed' && frame.requestId === 'invalid-' + kind)).toBe(true));
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    expect(t.a.inspectMesh().circuits.some(c => c.circuitId === circuitId)).toBe(false);
    peer.ws.close(); await once(peer.ws, 'close');
  }
  await healthy.channel.send('original-after-peer-protocol-refusals');
  await vi.waitFor(() => expect(healthy.messages).toEqual(['original-after-peer-protocol-refusals']));
}, 30000);
it('the standalone package runs three independent gateways with exclusive durable identity and monotonic restart epochs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-mesh-processes-'));
  privateRoots.push(root);
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const executable = resolve('packages/relay/bin/agentmux-relay');
  const identities = [];
  for (const name of ['a', 'b', 'c']) {
    const result = spawnSync(process.execPath, [executable, 'identity', '--state', join(root, name)], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.secretKey).toBeUndefined();
    identities.push(value);
  }
  const members = identities.map(({ peerId, publicKey }) => ({ peerId, publicKey }));
  const listener = createServer();
  await new Promise<void>(yes => listener.listen(0, '127.0.0.1', yes));
  const address = listener.address();
  if (!address || typeof address === 'string')
    throw Error('Private relay port unavailable');
  const port = address.port;
  await new Promise<void>(yes => listener.close(() => yes()));
  const paths: string[] = [];
  for (const [index, name] of ['a', 'b', 'c'].entries()) {
    const peers = index === 1 ? [{ peerId: identities[0].peerId, endpoints: [] }, { peerId: identities[2].peerId, endpoints: [] }] : [{ peerId: identities[1].peerId, endpoints: [{ endpoint: '127.0.0.1:' + port, useTls: false }] }];
    const serverId = index === 1 ? 'beta' : index === 2 ? 'alpha' : null, path = join(root, name + '.json');
    paths.push(path);
    await writeFile(path, JSON.stringify({ host: '127.0.0.1', port: index === 1 ? port : 0, publishers: serverId ? [{ serverId, tokenHash: hashPublisherToken(serverId + '-private') }] : [], meshStateDirectory: join(root, name), mesh: { networkId: 'private-process-network', members, peers } }), { mode: 0o600 });
  }
  const stop = async (child: ChildProcess) => { if (child.exitCode !== null || child.signalCode !== null)
    return; const ended = once(child, 'exit'); child.kill('SIGTERM'); expect(await ended).toEqual([0, null]); };
  const launch = async (path: string) => {
    const child = spawn(process.execPath, [executable, 'serve', '--config', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    assemblyPids.push(child.pid!);
    cleanup.push(() => stop(child));
    let errors = '';
    child.stderr!.on('data', value => { errors += String(value); });
    const lines = createInterface({ input: child.stdout! });
    cleanup.push(() => lines.close());
    const receipt = await Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line)), once(child, 'exit').then(() => { throw Error('Private mesh child startup failed: ' + errors); })]);
    return { child, receipt };
  };
  const b = await launch(paths[1]!), a = await launch(paths[0]!), c = await launch(paths[2]!);
  expect(new Set([a.child.pid, b.child.pid, c.child.pid]).size).toBe(3);
  const alpha = await publisher(c.receipt.port, 'alpha'), beta = await publisher(b.receipt.port, 'beta');
  const ready = async (port: number) => { await vi.waitFor(async () => expect((await (await fetch('http://127.0.0.1:' + port + '/healthz')).json()).mesh.publisherRoutes).toBe(2), { timeout: 10000 }); };
  await ready(a.receipt.port);
  const original = await client(a.receipt.port, 'alpha', alpha.daemon.publicKey), other = await client(a.receipt.port, 'beta', beta.daemon.publicKey);
  await original.channel.send('standalone-three-hop-original');
  await other.channel.send('standalone-second-publisher');
  await vi.waitFor(() => { expect(original.messages).toEqual(['standalone-three-hop-original']); expect(other.messages).toEqual(['standalone-second-publisher']); });
  const invalid = connectSocket({ port: a.receipt.port, host: '127.0.0.1' });
  invalid.on('error', () => {}); cleanup.push(() => { invalid.destroy(); });
  let invalidResponse = ''; invalid.on('data', value => { invalidResponse += String(value); });
  await once(invalid, 'connect'); const invalidClosed = once(invalid, 'close');
  invalid.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  await invalidClosed;
  expect(invalidResponse).toContain('400 Bad Request'); expect(a.child.exitCode).toBeNull();
  await original.channel.send('original-after-malformed-upgrade');
  await vi.waitFor(() => expect(original.messages.at(-1)).toBe('original-after-malformed-upgrade'));
  const competing = spawnSync(process.execPath, [executable, 'serve', '--config', paths[0]!], { encoding: 'utf8' });
  expect(competing.status).toBe(1);
  expect(JSON.parse(competing.stderr).error.code).toBe('MESH_STATE_IN_USE_OR_UNCONFIRMED');
  expect(a.child.exitCode).toBeNull();
  await stop(a.child);
  const restarted = await launch(paths[0]!);
  expect(restarted.receipt.mesh.identity.peerId).toBe(a.receipt.mesh.identity.peerId);
  expect(restarted.receipt.mesh.identity.publicKey).toBe(a.receipt.mesh.identity.publicKey);
  expect(restarted.receipt.mesh.identity.epoch).toBe(a.receipt.mesh.identity.epoch + 1);
  await ready(restarted.receipt.port);
  const reconnected = await client(restarted.receipt.port, 'alpha', alpha.daemon.publicKey);
  await reconnected.channel.send('explicit-new-request-after-restart');
  await vi.waitFor(() => expect(reconnected.messages).toEqual(['explicit-new-request-after-restart']));
  expect(alpha.received).toEqual(['standalone-three-hop-original', 'original-after-malformed-upgrade', 'explicit-new-request-after-restart']);
  expect(beta.received).toEqual(['standalone-second-publisher']);
  const privateState = JSON.parse(await readFile(join(root, 'a', 'identity.json'), 'utf8'));
  expect(privateState.identity.peerId).toBe(a.receipt.mesh.identity.peerId);
  expect(JSON.stringify([a.receipt, restarted.receipt])).not.toContain(privateState.identity.secretKey);
  facts.push({ case: 'independent-cli-gateways', processes: [a.child.pid, b.child.pid, c.child.pid, restarted.child.pid], before: a.receipt, restarted: restarted.receipt, alphaAccepted: alpha.received.length, betaAccepted: beta.received.length, originalDaemonPublicKeySHA256: createHash('sha256').update(alpha.daemon.publicKey).digest('hex') });
}, 45000);
