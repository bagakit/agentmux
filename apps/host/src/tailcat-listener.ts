import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { TailcatListenerObservation } from '@agentmux/core'
import { parseHostConfiguration, type LocalHostConfig, type TailcatListenerConfig } from './host-configuration.js'

const retryDetail = 'Fix the local Tailcat configuration or install the official tailcat CLI in PATH, then turn Tailcat off and on. Original Agents and SSH connections are retained.'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nonzeroKey = (value: unknown, prefix: string): boolean => typeof value === 'string' &&
  new RegExp('^' + prefix + '[0-9a-f]{64}$', 'u').test(value) && !value.endsWith('0'.repeat(64))

/** Read only the official saved-key format. The CLI remains the key/protocol owner. */
async function validateServerKey(name: string, environment: NodeJS.ProcessEnv): Promise<void> {
  if (!name || name === 'new' || /[\0\r\n]/u.test(name)) throw Error('A saved Tailcat server key is required.')
  let path = name
  if (/[/\\]/u.test(name)) {
    if (!isAbsolute(name)) throw Error('A saved Tailcat server key requires an absolute file path.')
  } else {
    // Match the official CLI's os.UserConfigDir keyPath; never create a missing identity.
    const home = environment.HOME ?? homedir()
    const config = process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
      : process.platform === 'win32' ? environment.APPDATA : environment.XDG_CONFIG_HOME || join(home, '.config')
    if (!config || !isAbsolute(config)) throw Error('The Tailcat key directory is unavailable.')
    path = join(config, 'tailcat', 'keys', name + '.private.json')
  }
  const key: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!record(key) || !nonzeroKey(key.Private, 'privkey:') || !record(key.Public) ||
      !nonzeroKey(key.Public.PresharedKey, 'psk:') ||
      !(Number.isSafeInteger(key.Public.RegionID) && Number(key.Public.RegionID) > 0 ||
        Array.isArray(key.Public.Region) && key.Public.Region.length === 1 && record(key.Public.Region[0]) &&
        Number.isSafeInteger(key.Public.Region[0].RegionID) && Number(key.Public.Region[0].RegionID) > 0)) {
    throw Error('Use an official saved Tailcat server key with a PSK and fixed DERP region.')
  }
}

type ListenerOptions = {
  socketPath: string
  prepareEnvironment?: () => Promise<void>
  /** The installed Core CLI, supplied by the Host's own package, never user shell text. */
  command?: { executable: string; args: readonly string[] }
  environment?: NodeJS.ProcessEnv
}

/** Owns this opt-in CLI listener only. It never creates or stops a semantic Core or Run. */
export class HostTailcatListener {
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private revision = 0
  private state: TailcatListenerObservation = { state: 'disabled' }
  private configuration: TailcatListenerConfig | undefined
  private closed = false
  constructor(private readonly options: ListenerOptions) {}
  inspect(): TailcatListenerObservation { return structuredClone(this.state) }
  configurationIssue(): void {
    this.state = { ...this.state, detail: 'Reading the original Tailcat configuration is unconfirmed. The last confirmed listener state is retained; restore the configuration and refresh.' }
  }
  async update(configuration: TailcatListenerConfig | undefined): Promise<void> {
    if (this.closed) return
    if (isDeepStrictEqual(configuration, this.configuration) && this.state.state !== 'failed') {
      const { detail: _detail, ...confirmed } = this.state
      this.state = confirmed
      return
    }
    this.configuration = structuredClone(configuration)
    const revision = ++this.revision
    await this.stopChild()
    if (revision !== this.revision || this.closed) return
    if (!configuration?.enabled) { this.state = { state: 'disabled' }; return }
    this.state = { state: 'starting' }
    try { await this.options.prepareEnvironment?.() }
    catch {
      if (revision === this.revision) this.state = { state: 'failed', detail: 'Preparing the Tailcat execution environment failed. ' + retryDetail }
      return
    }
    try {
      if (!configuration.allowedClients.length || configuration.allowedClients.some(key => !nonzeroKey(key, 'nodekey:'))) {
        throw Error('Tailcat requires an explicit nonempty client public-key allowlist.')
      }
      await validateServerKey(configuration.keyFile, this.options.environment ?? process.env)
    } catch {
      if (revision === this.revision) this.state = { state: 'failed', detail: 'The saved server key or client allowlist is invalid or unreadable. ' + retryDetail }
      return
    }
    if (revision !== this.revision || this.closed) return
    const command = this.options.command ?? { executable: process.execPath,
      args: [fileURLToPath(new URL('./agentmux.js', import.meta.resolve('@agentmux/core')))] }
    const args = ['serve', '--key=' + configuration.keyFile, '--allow=' + configuration.allowedClients.join(','), '--json', '--psk',
      'exec', '--', command.executable, ...command.args, '--endpoint', 'unix:' + this.options.socketPath, 'system', 'endpoint', '--stdio']
    const environment = { ...this.options.environment ?? process.env }
    // These ambient options could publish a credential or change the installed Core target.
    for (const name of ['TAILCAT_ADDR_FILE', 'TAILCAT_STATUS_LOOP', 'TS_DEBUG_TAILCAT_LOCAL_DERP', 'TS_DEBUG_TAILCAT_ADDR',
      'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_RPC_ENDPOINT', 'AGENTMUX_TOOL_CONTEXT']) delete environment[name]
    const child = spawn('tailcat', args, { stdio: ['pipe', 'pipe', 'pipe'], env: environment })
    this.child = child
    this.childClosed = new Promise(resolve => child.once('close', () => resolve()))
    child.stdin.end()
    // Official stderr includes the secret address and may include key-file content on errors.
    child.stderr.resume()
    const current = () => this.child === child && revision === this.revision && !this.closed
    const fail = (detail: string) => { if (current()) this.state = { state: 'failed', detail: detail + ' ' + retryDetail } }
    child.once('error', () => fail('The Tailcat CLI could not start.'))
    child.once('exit', () => fail('The Tailcat listener exited.'))
    let pending = '', received = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (!current() || received) return
      pending += chunk
      // This is one tiny machine readiness envelope, not business or terminal history.
      if (pending.length > 64 * 1024) { fail('The Tailcat readiness envelope is invalid.'); child.kill(); return }
      const newline = pending.indexOf('\n')
      if (newline < 0) return
      received = true
      try {
        const value: unknown = JSON.parse(pending.slice(0, newline)); pending = ''
        if (!record(value) || Object.keys(value).join(',') !== 'listenAddr' ||
            typeof value.listenAddr !== 'string' || !/^tc[A-Za-z0-9_-]+$/u.test(value.listenAddr)) throw Error('Invalid readiness')
        this.state = { state: 'listening', address: value.listenAddr }
      } catch { fail('The Tailcat readiness envelope is invalid.'); child.kill() }
    })
  }
  /** A changed allowlist is never served using a superseded authorization. */
  async rejectConfiguration(): Promise<void> {
    ++this.revision; this.configuration = undefined; await this.stopChild()
    if (!this.closed) this.state = { state: 'failed', detail: 'The local Tailcat configuration is invalid. ' + retryDetail }
  }
  private async stopChild(): Promise<void> {
    const child = this.child, closed = this.childClosed
    this.child = undefined; this.childClosed = undefined
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
  async close(): Promise<void> { this.closed = true; ++this.revision; await this.stopChild(); this.state = { state: 'disabled' } }
}

/** Observe the original application file; no second settings store or network polling. */
export function configuredTailcatListener(path: string | undefined, options: ListenerOptions) {
  const listener = new HostTailcatListener(options)
  let watcher: FSWatcher | undefined, pending: Promise<void> | undefined, dirty = false, closed = false
  let retry: NodeJS.Timeout | undefined
  let local: LocalHostConfig | undefined
  const apply = async () => {
    if (!path) return
    let raw: unknown
    try { raw = JSON.parse(await readFile(path, 'utf8')) }
    catch { listener.configurationIssue(); return }
    if (closed) return
    const hosts = record(raw) && Array.isArray(raw.hosts) ? raw.hosts.filter(value => record(value) && value.id === 'local') : []
    if (hosts.length !== 1) { listener.configurationIssue(); return }
    const candidate = hosts[0]
    const parsed = parseHostConfiguration(candidate)
    if (!parsed.success || parsed.data.kind !== 'local') {
      // A readable edited local record can revoke an old allowlist even when its replacement is invalid.
      if (!record(candidate) || !isDeepStrictEqual(candidate.tailcat, local?.tailcat)) await listener.rejectConfiguration()
      else listener.configurationIssue()
      return
    }
    local = parsed.data
    await listener.update(local.tailcat)
  }
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve()
    dirty = true
    if (!pending) pending = (async () => { while (dirty && !closed) {
      dirty = false
      try { await apply() } catch { listener.configurationIssue() }
    } })()
      .finally(() => { pending = undefined })
    return pending
  }
  const observe = () => {
    if (!path || watcher || closed) return
    const retryWatch = () => {
      listener.configurationIssue()
      if (!retry && !closed) retry = setTimeout(() => { retry = undefined; observe(); void refresh() }, 1000).unref()
    }
    try {
      const current = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (name === null || String(name) === basename(path)) void refresh()
      })
      watcher = current
      current.on('error', () => { if (watcher === current) watcher = undefined; current.close(); retryWatch() })
    } catch { retryWatch() }
  }
  return {
    inspect: () => listener.inspect(),
    async start(): Promise<void> {
      if (closed) return
      observe()
      await refresh()
    },
    async close(): Promise<void> { closed = true; watcher?.close(); if (retry) clearTimeout(retry); await pending; await listener.close() }
  }
}
