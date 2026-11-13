import { AgentMuxError } from './errors.js'
import { parseRemoteCoreHost } from './remote-core-upgrade-codec.js'
import type { RemoteCoreInstallCheck, RemoteCoreInstallExpected, RemoteCoreInstallProbe, RemoteCoreInstallReceipt, RemoteCoreKeepRunning } from './remote-core-install.js'

function invalid(): never { throw new AgentMuxError('Core install DTO is invalid.', 'CONTROL_PROTOCOL_ERROR') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0')) invalid()
  return value
}
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); return value as number }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value }
function digest(value: unknown): string { const s = text(value); if (!/^[a-f0-9]{64}$/u.test(s)) invalid(); return s }
function mode(value: unknown): RemoteCoreKeepRunning { if (value !== 'systemd' && value !== 'start-script') invalid(); return value }
function admission(value: unknown): Omit<RemoteCoreInstallExpected, 'keepRunning'> {
  const p = record(value, ['targetDigest', 'prefix', 'candidateDigest', 'nodeSha256'])
  const prefix = text(p.prefix); if (!prefix.startsWith('/')) invalid()
  return { targetDigest: digest(p.targetDigest), prefix, candidateDigest: digest(p.candidateDigest), nodeSha256: digest(p.nodeSha256) }
}
export function parseRemoteCoreInstallExpected(value: unknown): RemoteCoreInstallExpected {
  const p = record(value, ['targetDigest', 'prefix', 'candidateDigest', 'nodeSha256', 'keepRunning'])
  const { keepRunning, ...rest } = p
  return { ...admission(rest), keepRunning: mode(keepRunning) }
}
export function parseRemoteCoreInstallProbe(value: unknown): RemoteCoreInstallProbe {
  const p = record(value, ['platform', 'machine', 'glibc', 'home', 'prefix', 'user', 'installed', 'socket', 'availableBytes', 'systemd'])
  const systemd = record(p.systemd, ['user', 'linger', 'unitAvailable'])
  if (!['absent', 'stale', 'serving', 'other-file', 'unknown'].includes(text(p.socket))) invalid()
  return { platform: text(p.platform), machine: text(p.machine), glibc: p.glibc === null ? null : text(p.glibc), home: text(p.home),
    prefix: text(p.prefix), user: typeof p.user === 'string' && !p.user.includes('\0') ? p.user : invalid(),
    installed: bool(p.installed), socket: p.socket as RemoteCoreInstallProbe['socket'], availableBytes: count(p.availableBytes),
    systemd: { user: bool(systemd.user), unitAvailable: bool(systemd.unitAvailable), linger: systemd.linger === null ? null : bool(systemd.linger) } }
}
export function parseRemoteCoreInstallReceipt(value: unknown): RemoteCoreInstallReceipt {
  const p = record(value, ['input', 'operationId', 'expected', 'status', 'stage', 'detail', 'updatedAt', 'installed', 'connectionAdoption'])
  if (!['running', 'completed', 'failed', 'unknown'].includes(text(p.status)) ||
      !['preparing', 'pushing-node', 'staging-core', 'starting', 'confirming', 'completed'].includes(text(p.stage))) invalid()
  const expected = parseRemoteCoreInstallExpected(p.expected)
  let installed: RemoteCoreInstallReceipt['installed']
  if (p.installed !== undefined) {
    const i = record(p.installed, ['remoteCommand', 'remoteSocketPath', 'runtimeId', 'startScript', 'unit'])
    installed = { remoteCommand: text(i.remoteCommand), remoteSocketPath: text(i.remoteSocketPath), runtimeId: text(i.runtimeId),
      startScript: text(i.startScript), unit: i.unit === null ? null : text(i.unit) }
  }
  if (p.status === 'completed' && (p.stage !== 'completed' || !installed)) invalid()
  let connectionAdoption: RemoteCoreInstallReceipt['connectionAdoption']
  if (p.connectionAdoption !== undefined) {
    const a = record(p.connectionAdoption, ['state', 'readAt', 'detail', 'code'])
    if (p.status !== 'completed' || !['connected', 'unconfirmed', 'pending-confirmation'].includes(text(a.state))) invalid()
    connectionAdoption = { state: a.state as NonNullable<RemoteCoreInstallReceipt['connectionAdoption']>['state'], readAt: count(a.readAt), detail: text(a.detail),
      ...(a.code === undefined ? {} : { code: text(a.code) }) }
  }
  const operationId = text(p.operationId); if (!/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) invalid()
  return { input: parseRemoteCoreHost(p.input), operationId, expected, status: p.status as RemoteCoreInstallReceipt['status'],
    stage: p.stage as RemoteCoreInstallReceipt['stage'], detail: text(p.detail), updatedAt: count(p.updatedAt),
    ...(installed ? { installed } : {}), ...(connectionAdoption ? { connectionAdoption } : {}) }
}
export function parseRemoteCoreInstallCheck(value: unknown): RemoteCoreInstallCheck {
  const p = record(value, ['input', 'probe', 'eligible', 'reason', 'detail', 'candidate', 'node', 'keepRunning', 'expected', 'latestOperation', 'unreadableOperations'])
  if (!['ready', 'installed', 'unsupported', 'unverified'].includes(text(p.reason))) invalid()
  const eligible = bool(p.eligible)
  const expected = p.expected === undefined ? undefined : admission(p.expected)
  const c = p.candidate === undefined ? undefined : record(p.candidate, ['digest', 'sourceCommit', 'version'])
  const candidate = c && { digest: digest(c.digest), sourceCommit: c.sourceCommit === null ? null : text(c.sourceCommit), version: c.version === null ? null : text(c.version) }
  const n = p.node === undefined ? undefined : record(p.node, ['version', 'sha256'])
  const node = n && { version: text(n.version), sha256: digest(n.sha256) }
  let keepRunning: RemoteCoreInstallCheck['keepRunning']
  if (p.keepRunning !== undefined) {
    if (!Array.isArray(p.keepRunning)) invalid()
    keepRunning = p.keepRunning.map(value => { const k = record(value, ['mode', 'available', 'startsAtBoot'])
      return { mode: mode(k.mode), available: bool(k.available), startsAtBoot: k.startsAtBoot === null ? null : bool(k.startsAtBoot) } })
  }
  if (eligible && (p.reason !== 'ready' || !expected || !candidate || !node || !keepRunning?.length || !p.probe ||
      expected.candidateDigest !== candidate.digest || expected.nodeSha256 !== node.sha256)) invalid()
  if (p.unreadableOperations !== undefined && (!Array.isArray(p.unreadableOperations) || p.unreadableOperations.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)))) invalid()
  return { input: parseRemoteCoreHost(p.input), eligible, reason: p.reason as RemoteCoreInstallCheck['reason'], detail: text(p.detail),
    ...(p.probe === undefined ? {} : { probe: parseRemoteCoreInstallProbe(p.probe) }), ...(expected ? { expected } : {}),
    ...(candidate ? { candidate } : {}), ...(node ? { node } : {}), ...(keepRunning ? { keepRunning } : {}),
    ...(p.unreadableOperations === undefined ? {} : { unreadableOperations: [...p.unreadableOperations as string[]] }),
    ...(p.latestOperation === undefined ? {} : { latestOperation: parseRemoteCoreInstallReceipt(p.latestOperation) }) }
}
