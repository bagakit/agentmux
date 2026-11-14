import type { IncomingMessage, Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { SERVER_SOCKET_MAX_PAYLOAD } from './routing-server.js';
import { meshCanonical, meshInteger, meshList, meshObject, meshString, parseRelayMeshConfiguration, parseRelayMeshRecord, parseRelayMeshRoute, signMesh, verifyMesh, type RelayMeshConfiguration, type RelayMeshEndpoint, type RelayMeshObservation, type RelayMeshRecord, type RelayMeshRoute } from './mesh-protocol.js';
type Hello = {
  type: 'hello';
  networkId: string;
  peerId: string;
  epoch: number;
  nonce: string;
};
type Link = {
  ws: WebSocket;
  peerId: string;
  endpoint?: RelayMeshEndpoint;
  local: Hello;
  remote?: Hello;
  active: boolean;
  connectionId: string;
  rttMs: number;
  started: number;
  pingAt: number;
  timer?: NodeJS.Timeout;
  timeout?: NodeJS.Timeout;
};
type Circuit = {
  circuitId: string;
  serverId: string;
  path: string[];
  socket: WebSocket;
};
type Open = {
  circuitId: string;
  route: RelayMeshRoute;
  edges: { connectionId: string; sourceEpoch: number; targetEpoch: number }[];
  index: number;
  signature: string;
};
type Opening = {
  open: Open;
  controller: AbortController;
  current(): void;
  finish(): void;
  cancel(): void;
};
type Reservation = {
  link: Link;
  token: string;
  requestId: string;
  timer: NodeJS.Timeout;
  accept(ws: WebSocket): void;
  fail(error: Error): void;
};
type Pending = {
  link: Link;
  timer: NodeJS.Timeout;
  resolve(token: string): void;
  reject(error: Error): void;
};
export interface RelayMeshPorts {
  publishers(): {
    serverId: string;
    generation: string;
  }[];
  acceptClient(serverId: string, socket: WebSocket): void;
  bridge(source: WebSocket, opening: (signal: AbortSignal) => Promise<WebSocket>): () => void;
}
const nonce = () => randomBytes(24).toString('base64url');
const failure = () => new Error('The original Relay Mesh circuit is unavailable; encrypted payload is not replayed.');
const endpointUrl = (endpoint: RelayMeshEndpoint, path: string) => `${endpoint.useTls ? 'wss' : 'ws'}://${endpoint.endpoint}${path}`;
const rawRecord = (record: RelayMeshRecord) => { const { signature: _signature, ...body } = record; return body; };
/** Volatile authenticated topology/circuit owner. Original endpoint bytes stay opaque. */
export class RelayMeshNetwork {
  private config?: RelayMeshConfiguration;
  private readonly controls = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  private readonly data = new WebSocketServer({ noServer: true, maxPayload: SERVER_SOCKET_MAX_PAYLOAD, perMessageDeflate: false });
  private readonly links = new Map<string, Link>();
  private readonly candidates = new Set<Link>();
  private readonly records = new Map<string, RelayMeshRecord>();
  private readonly circuits = new Map<string, Circuit>();
  private readonly openings = new Map<string, Opening>();
  private readonly dataDials = new Set<{ socket: WebSocket; current(): void }>();
  private readonly dataSockets = new Map<WebSocket, string>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly pending = new Map<string, Pending>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private readonly retryCounts = new Map<string, number>();
  private readonly attachments = new Set<Server>();
  private readonly chosen = new Map<string, RelayMeshRoute>();
  private revision = 0;
  private stopped = false;
  constructor(private readonly ports: RelayMeshPorts, config?: RelayMeshConfiguration) { if (config)
    this.configure(config); }
  configure(value?: RelayMeshConfiguration): void {
    const next = value === undefined ? undefined : parseRelayMeshConfiguration(value);
    if (this.stopped)
      throw new Error('Relay Mesh is stopped.');
    if (this.config && next && (next.networkId !== this.config.networkId || meshCanonical(next.identity) !== meshCanonical(this.config.identity)))
      throw new Error('Keep the original network identity and reserved boot epoch for this runtime.');
    const previous = this.config;
    this.config = next;
    for (const [id, timer] of this.retries) {
      clearTimeout(timer);
      this.retries.delete(id);
    }
    for (const link of [...this.candidates]) {
      const target = next?.peers.find(p => p.peerId === link.peerId);
      if (!target || !next?.members.some(m => m.peerId === link.peerId)) {
        if (this.links.get(link.peerId) === link)
          this.links.delete(link.peerId);
        link.ws.terminate();
      }
    }
    this.cancelInvalidOpenings();
    for (const [socket, peerId] of this.dataSockets) if (!next?.peers.some(peer => peer.peerId === peerId)) socket.terminate();
    const members = new Set(next?.members.map(m => m.peerId) ?? []);
    for (const [id] of this.records)
      if (!members.has(id))
        this.records.delete(id);
    for (const circuit of this.circuits.values())
      if (!next || circuit.path.some(id => !members.has(id)) ||
        circuit.path.some((id, index) => index > 0 && circuit.path[index - 1] === next.identity.peerId && !next.peers.some(p => p.peerId === id) || index < circuit.path.length - 1 && circuit.path[index + 1] === next.identity.peerId && !next.peers.some(p => p.peerId === id)))
        circuit.socket.terminate();
    if (!next) {
      this.records.clear();
      this.chosen.clear();
      return;
    }
    this.publish();
    for (const peer of next.peers)
      if (!this.links.has(peer.peerId))
        this.dial(peer.peerId);
  }
  publisherChanged(): void { this.publish(); }
  private send(link: Link, value: unknown): void {
    if (link.ws.readyState !== WebSocket.OPEN)
      return;
    const text = JSON.stringify(value);
    // Control-plane in-flight work only; no lifetime/cumulative stream budget.
    if (Buffer.byteLength(text) > 1024 * 1024 || link.ws.bufferedAmount > 2 * 1024 * 1024) {
      link.ws.close(4008, 'Mesh control reader budget');
      return;
    }
    link.ws.send(text, error => { if (error)
      link.ws.terminate(); });
  }
  private dial(peerId: string): void {
    const config = this.config, peer = config?.peers.find(p => p.peerId === peerId);
    if (!config || !peer || this.stopped || this.links.has(peerId) || [...this.candidates].some(l => l.peerId === peerId && l.endpoint))
      return;
    const attempt = this.retryCounts.get(peerId) ?? 0, endpoint = peer.endpoints[attempt % peer.endpoints.length];
    if (!endpoint)
      return;
    const ws = new WebSocket(endpointUrl(endpoint, '/mesh'), { headers: { 'x-agentmux-mesh-peer': config.identity.peerId }, handshakeTimeout: 5000, maxPayload: 1024 * 1024, perMessageDeflate: false });
    const link = this.makeLink(ws, peerId, endpoint);
    ws.once('open', () => this.begin(link));
  }
  private retry(peerId: string): void {
    if (this.stopped || !this.config?.peers.some(p => p.peerId === peerId) || this.links.has(peerId) || this.retries.has(peerId))
      return;
    const attempt = this.retryCounts.get(peerId) ?? 0;
    this.retryCounts.set(peerId, attempt + 1);
    const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000) * (0.5 + Math.random() / 2);
    this.retries.set(peerId, setTimeout(() => { this.retries.delete(peerId); this.dial(peerId); }, delay).unref());
  }
  private makeLink(ws: WebSocket, peerId: string, endpoint?: RelayMeshEndpoint): Link {
    const config = this.config!;
    const link: Link = { ws, peerId, ...(endpoint ? { endpoint } : {}), local: { type: 'hello', networkId: config.networkId, peerId: config.identity.peerId, epoch: config.identity.epoch, nonce: nonce() }, active: false, connectionId: '', rttMs: 0, started: Date.now(), pingAt: 0 };
    this.candidates.add(link);
    link.timeout = setTimeout(() => ws.terminate(), 5000).unref();
    ws.on('error', () => ws.terminate());
    ws.on('message', raw => { try {
      this.receive(link, JSON.parse(raw.toString()));
    }
    catch {
      ws.close(4003, 'Invalid authenticated Mesh protocol');
    } });
    ws.on('pong', () => {
      if (!link.active || !link.pingAt)
        return;
      const measured = Math.max(1, Date.now() - link.pingAt), bucket = Math.ceil(measured / 10) * 10;
      link.pingAt = 0;
      if (bucket !== link.rttMs) {
        link.rttMs = bucket;
        this.publish();
      }
    });
    ws.once('close', () => {
      clearTimeout(link.timeout);
      clearInterval(link.timer);
      this.candidates.delete(link);
      if (this.links.get(peerId) === link) {
        this.links.delete(peerId);
        this.publish();
      }
      this.cancelInvalidOpenings();
      for (const [id, pending] of this.pending)
        if (pending.link === link) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(failure());
        }
      for (const [id, reservation] of this.reservations)
        if (reservation.link === link) {
          clearTimeout(reservation.timer);
          this.reservations.delete(id);
          reservation.fail(failure());
        }
      this.retry(peerId);
    });
    return link;
  }
  private begin(link: Link): void { this.send(link, link.local); }
  private proofBody(link: Link) {
    return { purpose: 'agentmux-relay-mesh-peer/1', hellos: [link.local, link.remote!].sort((a, b) => a.peerId.localeCompare(b.peerId)) };
  }
  private receive(link: Link, value: unknown): void {
    const config = this.config;
    if (!config)
      throw failure();
    const frame = meshObject(value, ['type', 'networkId', 'peerId', 'epoch', 'nonce', 'signature', 'record', 'requestId', 'open', 'token', 'reason']);
    if (!link.active) {
      if (frame.type === 'hello' && !link.remote) {
        const hello = meshObject(frame, ['type', 'networkId', 'peerId', 'epoch', 'nonce']);
        if (hello.peerId !== link.peerId || hello.networkId !== config.networkId || !config.peers.some(p => p.peerId === link.peerId))
          throw failure();
        const challenge = meshString(hello.nonce);
        if (!/^[A-Za-z0-9_-]{32}$/u.test(challenge))
          throw failure();
        link.remote = { type: 'hello', networkId: config.networkId, peerId: link.peerId, epoch: meshInteger(hello.epoch), nonce: challenge };
        this.send(link, { type: 'proof', signature: signMesh(this.proofBody(link), config.identity) });
        return;
      }
      if (frame.type !== 'proof' || !link.remote || !verifyMesh(this.proofBody(link), frame.signature, config.members.find(m => m.peerId === link.peerId)!.publicKey))
        throw failure();
      link.connectionId = createHash('sha256').update(meshCanonical(this.proofBody(link))).digest('hex');
      const incumbent = this.links.get(link.peerId);
      if (incumbent && (incumbent.remote!.epoch > link.remote.epoch || incumbent.remote!.epoch === link.remote.epoch && incumbent.connectionId < link.connectionId)) {
        link.ws.close(4009, 'Duplicate Mesh control');
        return;
      }
      this.links.set(link.peerId, link);
      link.active = true;
      clearTimeout(link.timeout);
      // A duplicate control election never closes independently owned data circuits.
      incumbent?.ws.close(4009, 'Duplicate Mesh control');
      link.rttMs = Math.ceil(Math.max(1, Date.now() - link.started) / 10) * 10;
      this.retryCounts.delete(link.peerId);
      link.timer = setInterval(() => { if (link.pingAt) {
        link.ws.terminate();
        return;
      } link.pingAt = Date.now(); link.ws.ping(); }, 10000).unref();
      this.publish();
      for (const record of this.records.values())
        this.send(link, { type: 'record', record });
      return;
    }
    if (this.links.get(link.peerId) !== link)
      throw failure();
    if (frame.type === 'record') {
      this.adoptRecord(frame.record, link);
      return;
    }
    const requestId = meshString(frame.requestId);
    if (frame.type === 'reserved') {
      const pending = this.pending.get(requestId);
      if (!pending || pending.link !== link)
        throw failure();
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(meshString(frame.token));
      return;
    }
    if (frame.type === 'failed') {
      const pending = this.pending.get(requestId);
      if (pending?.link === link) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(failure());
      }
      for (const [token, reservation] of this.reservations) if (reservation.link === link && reservation.requestId === requestId) {
        clearTimeout(reservation.timer); this.reservations.delete(token); reservation.fail(failure());
      }
      return;
    }
    if (frame.type !== 'open')
      throw failure();
    let lease: Opening | undefined;
    try {
      const open = this.parseOpen(frame.open, link);
      lease = this.claim(open, link);
      const original = lease;
      if (link.endpoint) {
        const token = meshString(frame.token);
        void this.dialData(link, token, original.controller.signal, original.current).then(ws => this.acceptCircuit(original, ws))
          .catch(() => { original.cancel(); this.send(link, { type: 'failed', requestId }); });
      } else {
        if (frame.token !== undefined) throw failure();
        const token = this.reserve(link, requestId, ws => this.acceptCircuit(original, ws), () => original.cancel(), original.controller.signal);
        this.send(link, { type: 'reserved', requestId, token });
      }
    } catch {
      lease?.cancel();
      // Refuse this exact attempted circuit; do not discard other healthy readers.
      this.send(link, { type: 'failed', requestId });
    }
  }
  private assertOpenCurrent(open: Open, incoming?: Link): void {
    const config = this.config, path = open.route.path, index = open.index;
    if (this.stopped || !config || path[index] !== config.identity.peerId || path.some(id => !config.members.some(m => m.peerId === id))) throw failure();
    for (const edgeIndex of [index - 1, index]) {
      if (edgeIndex < 0 || edgeIndex >= open.edges.length) continue;
      const neighbor = edgeIndex < index ? path[index - 1]! : path[index + 1]!;
      const link = this.links.get(neighbor), edge = open.edges[edgeIndex]!;
      if (!config.peers.some(p => p.peerId === neighbor) || !link?.active || link.ws.readyState !== WebSocket.OPEN || link.connectionId !== edge.connectionId ||
        (edgeIndex < index ? edge.targetEpoch !== config.identity.epoch || edge.sourceEpoch !== link.remote!.epoch : edge.sourceEpoch !== config.identity.epoch || edge.targetEpoch !== link.remote!.epoch) ||
        edgeIndex < index && incoming !== undefined && incoming !== link) throw failure();
    }
    if (index === path.length - 1 && !this.ports.publishers().some(p => p.serverId === open.route.serverId && p.generation === open.route.publisherGeneration)) throw failure();
  }
  private claim(open: Open, incoming?: Link): Opening {
    this.assertOpenCurrent(open, incoming);
    if (this.circuits.has(open.circuitId) || this.openings.has(open.circuitId)) throw failure();
    const own = this.config!.identity.peerId;
    const adjacent = open.route.path.filter((_id, index) => Math.abs(index - open.index) === 1);
    for (const id of adjacent) if ([...this.openings.values()].filter(o => {
      const index = o.open.route.path.indexOf(own); return o.open.route.path[index - 1] === id || o.open.route.path[index + 1] === id;
    }).length >= 128) throw failure();
    const controller = new AbortController();
    const lease: Opening = { open, controller,
      current: () => { if (controller.signal.aborted || this.openings.get(open.circuitId) !== lease) throw failure(); this.assertOpenCurrent(open, incoming); },
      finish: () => { if (this.openings.get(open.circuitId) === lease) this.openings.delete(open.circuitId); },
      cancel: () => { lease.finish(); controller.abort(); },
    };
    this.openings.set(open.circuitId, lease);
    return lease;
  }
  private cancelInvalidOpenings(): void {
    for (const lease of this.openings.values()) { try { lease.current(); } catch { lease.cancel(); } }
    for (const dial of this.dataDials) { try { dial.current(); } catch { dial.socket.terminate(); } }
  }
  private publish(): void {
    const config = this.config;
    if (!config || this.stopped)
      return;
    const body = { version: 1 as const, networkId: config.networkId, originPeerId: config.identity.peerId, epoch: config.identity.epoch, revision: ++this.revision,
      neighbors: [...this.links.values()].filter(l => l.active).map(l => ({ peerId: l.peerId, peerEpoch: l.remote!.epoch, connectionId: l.connectionId, rttMs: l.rttMs })).sort((a, b) => a.peerId.localeCompare(b.peerId)),
      publishers: this.ports.publishers().sort((a, b) => a.serverId.localeCompare(b.serverId)), advertisedIngress: [...(config.advertisedIngress ?? [])] };
    const record = { ...body, signature: signMesh(body, config.identity) };
    this.records.set(config.identity.peerId, record);
    for (const link of this.links.values())
      this.send(link, { type: 'record', record });
  }
  private adoptRecord(value: unknown, sender: Link): void {
    const config = this.config!, record = parseRelayMeshRecord(value), pin = config.members.find(m => m.peerId === record.originPeerId);
    if (record.networkId !== config.networkId)
      throw failure();
    // Peers can retain a wider configured membership. Their forwarded records do
    // not grant local membership, and a local revocation must not close that peer.
    if (!pin)
      return;
    if (!verifyMesh(rawRecord(record), record.signature, pin.publicKey) ||
      record.originPeerId === sender.peerId && record.epoch !== sender.remote!.epoch ||
      record.neighbors.some(n => n.peerId === record.originPeerId))
      throw failure();
    if (record.originPeerId === config.identity.peerId)
      return;
    const prior = this.records.get(record.originPeerId);
    if (prior && (record.epoch < prior.epoch || record.epoch === prior.epoch && record.revision <= prior.revision))
      return;
    this.records.set(record.originPeerId, record);
    for (const link of this.links.values())
      if (link !== sender)
        this.send(link, { type: 'record', record });
  }
  private edge(from: string, to: string): number | null {
    const a = this.records.get(from), b = this.records.get(to), ab = a?.neighbors.find(n => n.peerId === to), ba = b?.neighbors.find(n => n.peerId === from);
    if (!a || !b || !ab || !ba || ab.connectionId !== ba.connectionId || ab.peerEpoch !== b.epoch || ba.peerEpoch !== a.epoch)
      return null;
    if (from === this.config?.identity.peerId && this.links.get(to)?.connectionId !== ab.connectionId)
      return null;
    return Math.max(ab.rttMs, ba.rttMs);
  }
  routes(): RelayMeshRoute[] {
    const config = this.config;
    if (!config)
      return [];
    const self = config.identity.peerId, distances = new Map<string, {
      path: string[];
      rttMs: number;
    }>([[self, { path: [self], rttMs: 0 }]]);
    const unsettled = new Set(config.members.map(m => m.peerId));
    const compare = (a: {
      path: string[];
      rttMs: number;
    }, b: {
      path: string[];
      rttMs: number;
    }) => a.path.length - b.path.length || Math.floor(a.rttMs / 20) - Math.floor(b.rttMs / 20) || a.path.join('/').localeCompare(b.path.join('/'));
    while (unsettled.size) {
      const from = [...unsettled].filter(id => distances.has(id)).sort((a, b) => compare(distances.get(a)!, distances.get(b)!))[0];
      if (!from)
        break;
      unsettled.delete(from);
      const previous = distances.get(from)!;
      for (const to of unsettled) {
        const metric = this.edge(from, to);
        if (metric === null)
          continue;
        const next = { path: [...previous.path, to], rttMs: previous.rttMs + metric }, prior = distances.get(to);
        if (!prior || compare(next, prior) < 0)
          distances.set(to, next);
      }
    }
    const selected = new Map<string, RelayMeshRoute>();
    for (const [originPeerId, record] of this.records) {
      const path = distances.get(originPeerId);
      if (!path)
        continue;
      for (const publisher of record.publishers) {
        const candidate: RelayMeshRoute = { serverId: publisher.serverId, originPeerId, publisherGeneration: publisher.generation, path: path.path, hops: path.path.length - 1, rttMs: path.rttMs, advertisedIngress: record.advertisedIngress };
        const prior = selected.get(publisher.serverId);
        if (!prior || compare(candidate, prior) < 0)
          selected.set(publisher.serverId, candidate);
      }
    }
    for (const [id, route] of selected) {
      const old = this.chosen.get(id);
      if (old && old.originPeerId === route.originPeerId && old.publisherGeneration === route.publisherGeneration && old.path.length === route.path.length) {
        let metric = 0, valid = true;
        for (let i = 1; i < old.path.length; i++) {
          const rtt = this.edge(old.path[i - 1]!, old.path[i]!);
          if (rtt === null) {
            valid = false;
            break;
          }
          metric += rtt;
        }
        if (valid && Math.floor(metric / 20) === Math.floor(route.rttMs / 20))
          selected.set(id, { ...old, rttMs: metric });
      }
    }
    this.chosen.clear();
    for (const [id, route] of selected)
      this.chosen.set(id, route);
    return [...selected.values()].sort((a, b) => a.serverId.localeCompare(b.serverId));
  }
  resolvePublisher(serverId: string): RelayMeshRoute | null { return structuredClone(this.routes().find(r => r.serverId === serverId) ?? null); }
  private parseOpen(value: unknown, link: Link): Open {
    const p = meshObject(value, ['circuitId', 'route', 'edges', 'index', 'signature']), r = meshObject(p.route, ['serverId', 'originPeerId', 'publisherGeneration', 'path', 'hops', 'rttMs', 'advertisedIngress']);
    const path = meshList(r.path).map(meshString), index = meshInteger(p.index), config = this.config!;
    if (path.length > config.members.length || new Set(path).size !== path.length || path[index] !== config.identity.peerId || path[index - 1] !== link.peerId ||
      path.some(id => !config.members.some(m => m.peerId === id)) || path.at(-1) !== r.originPeerId || r.hops !== path.length - 1 || this.circuits.has(meshString(p.circuitId)))
      throw failure();
    const edges = meshList(p.edges).map(value => {
      const edge = meshObject(value, ['connectionId', 'sourceEpoch', 'targetEpoch']);
      return { connectionId: meshString(edge.connectionId), sourceEpoch: meshInteger(edge.sourceEpoch), targetEpoch: meshInteger(edge.targetEpoch) };
    });
    if (edges.length !== path.length - 1 || edges[index - 1]!.connectionId !== link.connectionId || edges[index - 1]!.sourceEpoch !== link.remote!.epoch || edges[index - 1]!.targetEpoch !== config.identity.epoch)
      throw failure();
    for (let i = index; i < path.length - 1; i++) {
      const from = this.records.get(path[i]!), to = this.records.get(path[i + 1]!), edge = from?.neighbors.find(n => n.peerId === path[i + 1]);
      if (this.edge(path[i]!, path[i + 1]!) === null || edge?.connectionId !== edges[i]!.connectionId || from?.epoch !== edges[i]!.sourceEpoch || to?.epoch !== edges[i]!.targetEpoch)
        throw failure();
    }
    const serverId = meshString(r.serverId), publisherGeneration = meshString(r.publisherGeneration), route = parseRelayMeshRoute(p.route);
    const origin = config.members.find(m => m.peerId === path[0]);
    if (!origin || !verifyMesh({ purpose: 'agentmux-relay-mesh-circuit/1', networkId: config.networkId, circuitId: p.circuitId, route, edges }, p.signature, origin.publicKey))
      throw failure();
    if (index === path.length - 1 && !this.ports.publishers().some(p => p.serverId === serverId && p.generation === publisherGeneration))
      throw failure();
    return { circuitId: meshString(p.circuitId), index, route, edges, signature: meshString(p.signature) };
  }
  private reserve(link: Link, requestId: string, accept: (ws: WebSocket) => void, fail: (error: Error) => void, signal: AbortSignal): string {
    if ([...this.reservations.values()].filter(r => r.link === link).length >= 128)
      throw failure();
    if (signal.aborted) throw failure();
    const cleanup = () => { clearTimeout(timer); this.reservations.delete(token); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); fail(failure()); };
    const token = nonce(), timer = setTimeout(abort, 10000).unref();
    this.reservations.set(token, { link, requestId, token, timer,
      accept: ws => { cleanup(); if (signal.aborted) ws.terminate(); else accept(ws); },
      fail: error => { cleanup(); fail(error); },
    });
    signal.addEventListener('abort', abort, { once: true });
    return token;
  }
  private dialData(link: Link, token: string, signal: AbortSignal, current: () => void): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (!link.endpoint || signal.aborted) {
        reject(failure());
        return;
      }
      try { current(); } catch (error) { reject(error); return; }
      const ws = new WebSocket(endpointUrl(link.endpoint, '/mesh/data'), { headers: { authorization: 'Bearer ' + token, 'x-agentmux-mesh-peer': this.config!.identity.peerId }, maxPayload: SERVER_SOCKET_MAX_PAYLOAD, handshakeTimeout: 5000, perMessageDeflate: false });
      this.ownDataSocket(ws, link.peerId);
      const dial = { socket: ws, current };
      this.dataDials.add(dial);
      const abort = () => { ws.terminate(); reject(failure()); };
      signal.addEventListener('abort', abort, { once: true });
      ws.once('open', () => { ws.pause(); try { signal.throwIfAborted(); current(); this.dataDials.delete(dial); resolve(ws); } catch (error) { ws.terminate(); reject(error); } });
      ws.on('error', reject);
      ws.once('close', () => { this.dataDials.delete(dial); signal.removeEventListener('abort', abort); reject(failure()); });
    });
  }
  private async segment(open: Open, signal: AbortSignal): Promise<WebSocket> {
    this.assertOpenCurrent(open);
    const next = open.route.path[open.index + 1], link = next ? this.links.get(next) : undefined;
    if (!link?.active || signal.aborted)
      throw failure();
    const requestId = nonce(), wire = { ...open, index: open.index + 1 };
    if (link.endpoint) {
      const token = await new Promise<string>((resolve, reject) => {
        if ([...this.pending.values()].filter(p => p.link === link).length >= 128) {
          reject(failure());
          return;
        }
        const cleanup = () => { clearTimeout(timer); this.pending.delete(requestId); signal.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(failure()); };
        const timer = setTimeout(abort, 10000).unref();
        this.pending.set(requestId, { link, timer, resolve: token => { cleanup(); resolve(token); }, reject: error => { cleanup(); reject(error); } });
        signal.addEventListener('abort', abort, { once: true });
        this.send(link, { type: 'open', requestId, open: wire });
      });
      signal.throwIfAborted();
      return await this.dialData(link, token, signal, () => this.assertOpenCurrent(open));
    }
    return await new Promise<WebSocket>((resolve, reject) => {
      const token = this.reserve(link, requestId, ws => { try { this.assertOpenCurrent(open); resolve(ws); } catch (error) { ws.terminate(); reject(error); } }, reject, signal);
      this.send(link, { type: 'open', requestId, open: wire, token });
    });
  }
  private track(open: Open, ws: WebSocket): void {
    if (this.circuits.has(open.circuitId) || ws.readyState !== WebSocket.OPEN) throw failure();
    const adjacent = open.route.path.filter((_id, i) => Math.abs(i - open.index) === 1);
    const self = this.config!.identity.peerId;
    if (adjacent.some(id => [...this.circuits.values()].filter(c => {
      const index = c.path.indexOf(self); return c.path[index - 1] === id || c.path[index + 1] === id;
    }).length >= 128)) {
      ws.terminate();
      throw failure();
    }
    this.circuits.set(open.circuitId, { circuitId: open.circuitId, serverId: open.route.serverId, path: open.route.path, socket: ws });
    ws.once('close', () => { if (this.circuits.get(open.circuitId)?.socket === ws)
      this.circuits.delete(open.circuitId); });
  }
  private acceptCircuit(lease: Opening, ws: WebSocket): void {
    try {
      lease.current();
      const open = lease.open;
      this.track(open, ws);
      lease.finish();
      if (open.index === open.route.path.length - 1)
        this.ports.acceptClient(open.route.serverId, ws);
      else
        this.ports.bridge(ws, signal => this.segment(open, signal));
      ws.resume();
    }
    catch {
      lease.cancel();
      ws.terminate();
    }
  }
  async openClient(serverId: string, signal: AbortSignal): Promise<WebSocket> {
    const route = this.resolvePublisher(serverId);
    if (!route || route.hops < 1)
      throw failure();
    const edges = route.path.slice(1).map((toId, index) => {
      const from = this.records.get(route.path[index]!)!, to = this.records.get(toId)!, edge = from.neighbors.find(n => n.peerId === toId)!;
      return { connectionId: edge.connectionId, sourceEpoch: from.epoch, targetEpoch: to.epoch };
    });
    const circuitId = nonce(), open = { circuitId, route, edges, index: 0, signature: signMesh({ purpose: 'agentmux-relay-mesh-circuit/1', networkId: this.config!.networkId, circuitId, route, edges }, this.config!.identity) };
    const lease = this.claim(open);
    try {
      const ws = await this.segment(open, AbortSignal.any([signal, lease.controller.signal]));
      try { signal.throwIfAborted(); lease.current(); this.track(open, ws); lease.finish(); return ws; }
      catch (error) { ws.terminate(); throw error; }
    } catch (error) { lease.cancel(); throw error; }
  }
  private upgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    let path: URL;
    try { path = new URL(request.url ?? '/', 'http://localhost'); }
    catch {
      if (!socket.destroyed && !socket.writableEnded) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (path.pathname !== '/mesh' && path.pathname !== '/mesh/data')
      return;
    const deny = () => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const config = this.config, peerId = request.headers['x-agentmux-mesh-peer'];
    if (!config || this.stopped || typeof peerId !== 'string' || path.search || !config.peers.some(p => p.peerId === peerId)) {
      deny();
      return;
    }
    if (path.pathname === '/mesh') {
      if ([...this.candidates].filter(l => l.peerId === peerId).length >= 4) {
        deny();
        return;
      }
      this.controls.handleUpgrade(request, socket, head, ws => { const link = this.makeLink(ws, peerId); this.begin(link); });
    }
    else {
      const authorization = request.headers.authorization, token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '', r = this.reservations.get(token);
      if (!r || r.link.peerId !== peerId || this.links.get(peerId) !== r.link || !r.link.active) {
        deny();
        return;
      }
      this.reservations.delete(token);
      clearTimeout(r.timer);
      this.data.handleUpgrade(request, socket, head, ws => { this.ownDataSocket(ws, peerId); ws.pause(); r.accept(ws); });
    }
  };
  private ownDataSocket(socket: WebSocket, peerId: string): void {
    this.dataSockets.set(socket, peerId);
    socket.on('error', () => socket.terminate());
    socket.once('close', () => this.dataSockets.delete(socket));
  }
  attach(server: Server) { if (this.stopped || this.attachments.has(server))
    throw new Error('Mesh listener already attached.'); this.attachments.add(server); server.on('upgrade', this.upgrade); return { detach: () => { this.attachments.delete(server); server.removeListener('upgrade', this.upgrade); } }; }
  inspect(): RelayMeshObservation {
    const c = this.config;
    return structuredClone({ protocol: 1, state: c ? 'active' : 'disabled', networkId: c?.networkId ?? null, identity: c ? { peerId: c.identity.peerId, publicKey: c.identity.publicKey, epoch: c.identity.epoch } : null,
      peers: c?.peers.map(p => { const l = this.links.get(p.peerId); return { peerId: p.peerId, state: l ? 'connected' : this.retries.has(p.peerId) ? 'disconnected' : 'connecting', connectionId: l?.connectionId ?? null, rttMs: l?.rttMs ?? null }; }) ?? [],
      records: [...this.records.values()], routes: this.routes(), circuits: [...this.circuits.values()].map(({ socket: _socket, ...publicCircuit }) => publicCircuit) }) as RelayMeshObservation;
  }
  async stop(): Promise<void> {
    if (this.stopped)
      return;
    this.stopped = true;
    const sockets = new Set([...this.candidates].map(link => link.ws).concat([...this.dataSockets.keys()]));
    const closed = [...sockets].map(socket => socket.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise<void>(resolve => socket.once('close', () => resolve())));
    for (const lease of this.openings.values()) lease.cancel();
    for (const dial of this.dataDials) dial.socket.terminate();
    for (const socket of sockets) socket.terminate();
    for (const server of this.attachments)
      server.removeListener('upgrade', this.upgrade);
    this.attachments.clear();
    for (const timer of this.retries.values())
      clearTimeout(timer);
    this.retries.clear();
    for (const l of this.candidates)
      l.ws.terminate();
    for (const c of this.circuits.values())
      c.socket.terminate();
    for (const r of this.reservations.values()) {
      clearTimeout(r.timer);
      r.fail(failure());
    }
    this.reservations.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(failure());
    }
    this.pending.clear();
    for (const server of [this.controls, this.data])
      for (const ws of server.clients)
        ws.terminate();
    await Promise.all([this.controls, this.data].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
    await Promise.all(closed);
    this.config = undefined; this.links.clear(); this.candidates.clear(); this.records.clear(); this.circuits.clear(); this.openings.clear(); this.dataDials.clear(); this.dataSockets.clear(); this.chosen.clear();
  }
}
