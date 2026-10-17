import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isIP } from 'node:net'
import { AgentMuxError } from './errors.js'
import { agentMuxRpcSshArguments } from './public-rpc-client.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from './public-rpc-wire.js'
import type { AgentMuxRpcEndpoint } from './public-rpc.js'

const execute = promisify(execFile)
export type SshConfiguredJump = { host: string; user: string | null; port: number | null }
/** A new OpenSSH configuration evaluation, never the policy adopted by an existing channel. */
export type SshNetworkConfiguration = {
  hostname: string; user: string; port: number
  serverAliveInterval: number; serverAliveCountMax: number
  tcpKeepAlive: 'yes' | 'no' | 'transport' | 'all'
  proxy: 'direct' | 'jump' | 'command'
  jumps: SshConfiguredJump[]
}
function invalid(): never { throw new AgentMuxError('OpenSSH network configuration could not be confirmed.', 'SSH_CONFIGURATION_UNCONFIRMED') }
function number(value: string | undefined, port = false): number {
  if (value === undefined || !/^\d+$/u.test(value)) return invalid()
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < (port ? 1 : 0) || port && result > 65535) return invalid()
  return result
}
function jump(value: string): SshConfiguredJump {
  if (value.startsWith('ssh://')) {
    let url: URL
    try { url = new URL(value) } catch { return invalid() }
    if (url.protocol !== 'ssh:' || !url.hostname || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return invalid()
    return { host: url.hostname.replace(/^\[|\]$/gu, ''), user: url.username ? decodeURIComponent(url.username) : null,
      port: url.port ? number(url.port, true) : null }
  }
  const at = value.lastIndexOf('@'), user = at < 0 ? null : value.slice(0, at), target = at < 0 ? value : value.slice(at + 1)
  if (user === '' || user && /[\s/]/u.test(user)) return invalid()
  if (isIP(target) === 6) return { host: target, user, port: null }
  const match = /^(\[[^\]]+\]|[^:\s/]+)(?::(\d+))?$/u.exec(target)
  if (!match) return invalid()
  const host = match[1]!.replace(/^\[|\]$/gu, '')
  if (!host || host.startsWith('-') || /[\0\r\n]/u.test(host)) return invalid()
  return { host, user, port: match[2] === undefined ? null : number(match[2], true) }
}
/** Only documented key/value configuration output is consumed; no human diagnostic parsing. */
export function parseSshNetworkConfiguration(text: string): SshNetworkConfiguration {
  const fields = new Map<string, string>()
  const keys = new Set(['hostname', 'user', 'port', 'serveraliveinterval', 'serveralivecountmax', 'tcpkeepalive', 'proxyjump', 'proxycommand'])
  for (const line of text.split('\n')) {
    const split = line.indexOf(' ')
    if (split < 1) continue
    const key = line.slice(0, split).toLowerCase()
    if (!keys.has(key)) continue
    if (fields.has(key)) return invalid()
    fields.set(key, line.slice(split + 1).trim())
  }
  const hostname = fields.get('hostname'), user = fields.get('user'), tcpKeepAlive = fields.get('tcpkeepalive')
  if (!hostname || !user || /[\0\r\n]/u.test(hostname + user) || !['yes', 'no', 'transport', 'all'].includes(tcpKeepAlive ?? '')) return invalid()
  const chain = fields.get('proxyjump'), command = fields.get('proxycommand')
  const jumps = chain && chain !== 'none' ? chain.split(',').map(jump) : []
  return { hostname, user, port: number(fields.get('port'), true),
    serverAliveInterval: number(fields.get('serveraliveinterval')), serverAliveCountMax: number(fields.get('serveralivecountmax')),
    tcpKeepAlive: tcpKeepAlive as SshNetworkConfiguration['tcpKeepAlive'],
    proxy: jumps.length ? 'jump' : command && command !== 'none' ? 'command' : 'direct', jumps }
}
/** Explicit selected-route read. -G can evaluate the user's Match exec; never poll it. */
export async function readSshNetworkConfiguration(endpoint: Extract<AgentMuxRpcEndpoint, { transport: 'ssh' }>, signal?: AbortSignal): Promise<SshNetworkConfiguration> {
  try {
    const { stdout } = await execute('ssh', ['-G', ...agentMuxRpcSshArguments(endpoint)], {
      encoding: 'utf8', ...(signal ? { signal } : {}), maxBuffer: AGENTMUX_RPC_MAX_MESSAGE_BYTES
    })
    signal?.throwIfAborted()
    return parseSshNetworkConfiguration(stdout)
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof AgentMuxError) throw error
    // Raw output can contain private Match/ProxyCommand configuration and paths.
    throw new AgentMuxError('OpenSSH configuration evaluation failed. Review this Host’s SSH configuration and read it again; existing connections are retained.', 'SSH_CONFIGURATION_UNAVAILABLE')
  }
}
