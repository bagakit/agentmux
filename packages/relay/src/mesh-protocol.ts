import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
export interface RelayMeshEndpoint {
  endpoint: string;
  useTls: boolean;
}
export interface RelayMeshIdentity {
  peerId: string;
  publicKey: string;
  secretKey: string;
  epoch: number;
}
export interface RelayMeshMember {
  peerId: string;
  publicKey: string;
}
export interface RelayMeshConfiguration {
  networkId: string;
  identity: RelayMeshIdentity;
  members: readonly RelayMeshMember[];
  peers: readonly {
    peerId: string;
    endpoints: readonly RelayMeshEndpoint[];
  }[];
  advertisedIngress?: readonly RelayMeshEndpoint[];
}
export interface RelayMeshRecord {
  version: 1;
  networkId: string;
  originPeerId: string;
  epoch: number;
  revision: number;
  neighbors: {
    peerId: string;
    peerEpoch: number;
    connectionId: string;
    rttMs: number;
  }[];
  publishers: {
    serverId: string;
    generation: string;
  }[];
  advertisedIngress: RelayMeshEndpoint[];
  signature: string;
}
export interface RelayMeshRoute {
  serverId: string;
  originPeerId: string;
  publisherGeneration: string;
  path: string[];
  hops: number;
  rttMs: number;
  advertisedIngress: RelayMeshEndpoint[];
}
export interface RelayMeshObservation {
  protocol: 1;
  state: 'disabled' | 'active';
  networkId: string | null;
  identity: {
    peerId: string;
    publicKey: string;
    epoch: number;
  } | null;
  peers: {
    peerId: string;
    state: 'connecting' | 'connected' | 'disconnected';
    connectionId: string | null;
    rttMs: number | null;
  }[];
  records: RelayMeshRecord[];
  routes: RelayMeshRoute[];
  circuits: {
    circuitId: string;
    serverId: string;
    path: string[];
  }[];
}
const fail = (): never => { throw new Error('Invalid Relay Mesh protocol or configuration.'); };
export function meshObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)))
    fail();
  return value as Record<string, unknown>;
}
export function meshString(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value))
    fail();
  return value as string;
}
export function meshInteger(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    fail();
  return value as number;
}
export function meshList(value: unknown): unknown[] { if (!Array.isArray(value))
  fail(); return value as unknown[]; }
export function meshBytes(value: unknown, size: number): Uint8Array {
  const text = meshString(value), bytes = Buffer.from(text, 'base64');
  if (bytes.byteLength !== size || bytes.toString('base64') !== text)
    fail();
  return bytes;
}
export function relayMeshPeerId(publicKey: string): string {
  return createHash('sha256').update(meshBytes(publicKey, 32)).digest('hex');
}
export function createRelayMeshIdentity(): Omit<RelayMeshIdentity, 'epoch'> {
  const pair = nacl.sign.keyPair(), publicKey = Buffer.from(pair.publicKey).toString('base64');
  return { peerId: relayMeshPeerId(publicKey), publicKey, secretKey: Buffer.from(pair.secretKey).toString('base64') };
}
export function parseRelayMeshEndpoint(value: unknown): RelayMeshEndpoint {
  const p = meshObject(value, ['endpoint', 'useTls']), endpoint = meshString(p.endpoint);
  if (typeof p.useTls !== 'boolean' || /[\s/?#@]/u.test(endpoint))
    fail();
  const url = new URL(`${p.useTls ? 'https' : 'http'}://${endpoint}`);
  if (url.host !== endpoint || !url.hostname)
    fail();
  return { endpoint, useTls: p.useTls as boolean };
}
export function parseRelayMeshConfiguration(value: unknown): RelayMeshConfiguration {
  const p = meshObject(value, ['networkId', 'identity', 'members', 'peers', 'advertisedIngress']);
  const i = meshObject(p.identity, ['peerId', 'publicKey', 'secretKey', 'epoch']);
  const publicKey = meshString(i.publicKey), secretKey = meshString(i.secretKey);
  if (relayMeshPeerId(publicKey) !== i.peerId || !nacl.verify(nacl.sign.keyPair.fromSeed(meshBytes(secretKey, 64).slice(0, 32)).secretKey, meshBytes(secretKey, 64)) || !nacl.verify(nacl.sign.keyPair.fromSeed(meshBytes(secretKey, 64).slice(0, 32)).publicKey, meshBytes(publicKey, 32)))
    fail();
  const identity = { peerId: meshString(i.peerId), publicKey, secretKey, epoch: meshInteger(i.epoch) };
  const members = meshList(p.members).map(value => {
    const m = meshObject(value, ['peerId', 'publicKey']), publicKey = meshString(m.publicKey);
    if (relayMeshPeerId(publicKey) !== m.peerId)
      fail();
    return { peerId: meshString(m.peerId), publicKey };
  });
  const pins = new Map(members.map(m => [m.peerId, m.publicKey]));
  if (pins.size !== members.length || pins.get(identity.peerId) !== identity.publicKey)
    fail();
  const peers = meshList(p.peers).map(value => {
    const m = meshObject(value, ['peerId', 'endpoints']), peerId = meshString(m.peerId);
    if (peerId === identity.peerId || !pins.has(peerId))
      fail();
    return { peerId, endpoints: meshList(m.endpoints).map(parseRelayMeshEndpoint) };
  });
  if (new Set(peers.map(m => m.peerId)).size !== peers.length)
    fail();
  return { networkId: meshString(p.networkId), identity, members, peers,
    ...(p.advertisedIngress === undefined ? {} : { advertisedIngress: meshList(p.advertisedIngress).map(parseRelayMeshEndpoint) }) };
}
/** Canonical machine encoding; object key order is independent of transport JSON. */
export function meshCanonical(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(meshCanonical).join(',') + ']';
  if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + meshCanonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function signMesh(value: unknown, identity: RelayMeshIdentity): string {
  return Buffer.from(nacl.sign.detached(Buffer.from(meshCanonical(value)), meshBytes(identity.secretKey, 64))).toString('base64');
}
export function verifyMesh(value: unknown, signature: unknown, publicKey: string): boolean {
  try {
    return nacl.sign.detached.verify(Buffer.from(meshCanonical(value)), meshBytes(signature, 64), meshBytes(publicKey, 32));
  }
  catch {
    return false;
  }
}
export function parseRelayMeshRecord(value: unknown): RelayMeshRecord {
  const p = meshObject(value, ['version', 'networkId', 'originPeerId', 'epoch', 'revision', 'neighbors', 'publishers', 'advertisedIngress', 'signature']);
  if (p.version !== 1)
    fail();
  const neighbors = meshList(p.neighbors).map(value => {
    const n = meshObject(value, ['peerId', 'peerEpoch', 'connectionId', 'rttMs']);
    return { peerId: meshString(n.peerId), peerEpoch: meshInteger(n.peerEpoch), connectionId: meshString(n.connectionId), rttMs: meshInteger(n.rttMs, 0) };
  });
  const publishers = meshList(p.publishers).map(value => {
    const n = meshObject(value, ['serverId', 'generation']);
    return { serverId: meshString(n.serverId), generation: meshString(n.generation) };
  });
  if (new Set(neighbors.map(n => n.peerId)).size !== neighbors.length || new Set(publishers.map(n => n.serverId)).size !== publishers.length)
    fail();
  meshBytes(p.signature, 64);
  return { version: 1, networkId: meshString(p.networkId), originPeerId: meshString(p.originPeerId), epoch: meshInteger(p.epoch), revision: meshInteger(p.revision), neighbors, publishers,
    advertisedIngress: meshList(p.advertisedIngress).map(parseRelayMeshEndpoint), signature: meshString(p.signature) };
}
export function parseRelayMeshObservation(value: unknown): RelayMeshObservation {
  const p = meshObject(value, ['protocol', 'state', 'networkId', 'identity', 'peers', 'records', 'routes', 'circuits'])
  if (p.protocol !== 1 || !['disabled', 'active'].includes(p.state as string)) fail()
  const identity = p.identity === null ? null : (() => {
    const i = meshObject(p.identity, ['peerId', 'publicKey', 'epoch'])
    const publicKey = meshString(i.publicKey)
    if (relayMeshPeerId(publicKey) !== i.peerId) fail()
    return { peerId: meshString(i.peerId), publicKey, epoch: meshInteger(i.epoch) }
  })()
  const peers = meshList(p.peers).map(value => {
    const i = meshObject(value, ['peerId', 'state', 'connectionId', 'rttMs'])
    if (!['connecting', 'connected', 'disconnected'].includes(i.state as string)) fail()
    const connectionId = i.connectionId === null ? null : meshString(i.connectionId)
    const rttMs = i.rttMs === null ? null : meshInteger(i.rttMs, 0)
    if ((i.state === 'connected') !== (connectionId !== null && rttMs !== null)) fail()
    return { peerId: meshString(i.peerId), state: i.state as RelayMeshObservation['peers'][number]['state'], connectionId, rttMs }
  })
  const records = meshList(p.records).map(parseRelayMeshRecord)
  const routes = meshList(p.routes).map(parseRelayMeshRoute)
  const circuits = meshList(p.circuits).map(value => {
    const i = meshObject(value, ['circuitId', 'serverId', 'path'])
    const path = meshList(i.path).map(meshString)
    if (path.length < 2 || new Set(path).size !== path.length) fail()
    return { circuitId: meshString(i.circuitId), serverId: meshString(i.serverId), path }
  })
  const networkId = p.networkId === null ? null : meshString(p.networkId)
  if (p.state === 'disabled') {
    if (identity !== null || networkId !== null || peers.length || records.length || routes.length || circuits.length) fail()
  } else if (!identity || !networkId || records.some(r => r.networkId !== networkId) ||
    routes.some(r => r.path[0] !== identity.peerId) || circuits.some(c => !c.path.includes(identity.peerId))) fail()
  for (const ids of [peers.map(x => x.peerId), records.map(x => x.originPeerId), routes.map(x => x.serverId), circuits.map(x => x.circuitId)])
    if (new Set(ids).size !== ids.length) fail()
  return { protocol: 1, state: p.state as RelayMeshObservation['state'], networkId, identity, peers, records, routes, circuits }
}
export function parseRelayMeshRoute(value: unknown): RelayMeshRoute {
  const i = meshObject(value, ['serverId', 'originPeerId', 'publisherGeneration', 'path', 'hops', 'rttMs', 'advertisedIngress']);
  const path = meshList(i.path).map(meshString);
  if (!path.length || new Set(path).size !== path.length || i.hops !== path.length - 1 || path.at(-1) !== i.originPeerId)
    fail();
  return { serverId: meshString(i.serverId), originPeerId: meshString(i.originPeerId), publisherGeneration: meshString(i.publisherGeneration), path, hops: meshInteger(i.hops, 0), rttMs: meshInteger(i.rttMs, 0), advertisedIngress: meshList(i.advertisedIngress).map(parseRelayMeshEndpoint) };
}
