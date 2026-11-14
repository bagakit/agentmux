import { spawn } from 'node:child_process'
import { access, link, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { AgentMuxError, isTailcatNodePublicKey, type TailcatKeyPreparation, type TailcatKeyRole } from '@agentmux/core'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nonzeroKey = (value: unknown, prefix: string): boolean => typeof value === 'string' &&
  new RegExp('^' + prefix + '[0-9a-f]{64}$', 'u').test(value) && !value.endsWith('0'.repeat(64))

/** Match the official CLI's keyPath: a path names itself, a bare name lives under os.UserConfigDir. */
function tailcatKeyPath(name: string, environment: NodeJS.ProcessEnv): string {
  if (/[/\\]/u.test(name)) {
    if (!isAbsolute(name)) throw Error('A saved Tailcat key requires an absolute file path.')
    return name
  }
  const home = environment.HOME ?? homedir()
  const config = process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? environment.APPDATA : environment.XDG_CONFIG_HOME || join(home, '.config')
  if (!config || !isAbsolute(config)) throw Error('The Tailcat key directory is unavailable.')
  return join(config, 'tailcat', 'keys', name + '.private.json')
}

/** Read only the official saved-key format. The CLI remains the key/protocol owner; a missing identity is never created here. */
export async function validateServerKey(name: string, environment: NodeJS.ProcessEnv): Promise<void> {
  if (!name || name === 'new' || /[\0\r\n]/u.test(name)) throw Error('A saved Tailcat server key is required.')
  const key: unknown = JSON.parse(await readFile(tailcatKeyPath(name, environment), 'utf8'))
  if (!record(key) || !nonzeroKey(key.Private, 'privkey:') || !record(key.Public) ||
      !nonzeroKey(key.Public.PresharedKey, 'psk:') ||
      !(Number.isSafeInteger(key.Public.RegionID) && Number(key.Public.RegionID) > 0 ||
        Array.isArray(key.Public.Region) && key.Public.Region.length === 1 && record(key.Public.Region[0]) &&
        Number.isSafeInteger(key.Public.Region[0].RegionID) && Number(key.Public.Region[0].RegionID) > 0)) {
    throw Error('Use an official saved Tailcat server key with a PSK and fixed DERP region.')
  }
}

/** Ambient options that could publish a credential or retarget the installed Core never reach the official CLI. */
export function tailcatEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...environment }
  for (const name of ['TAILCAT_ADDR_FILE', 'TAILCAT_STATUS_LOOP', 'TS_DEBUG_TAILCAT_LOCAL_DERP', 'TS_DEBUG_TAILCAT_ADDR',
    'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_RPC_ENDPOINT', 'AGENTMUX_TOOL_CONTEXT']) delete scrubbed[name]
  return scrubbed
}

const unchanged = 'Existing keys, connections and Agents are unchanged.'
const unavailable = (detail: string) => new AgentMuxError(`${detail} ${unchanged}`, 'TAILCAT_UNAVAILABLE')

/** One official CLI invocation. Output is read only when asked: a new server key prints its private address. */
function runTailcat(args: string[], environment: NodeJS.ProcessEnv, readOutput: boolean, signal?: AbortSignal) {
  return new Promise<{ ok: boolean; output: string }>((resolve, reject) => {
    const child = spawn('tailcat', args, { env: environment, stdio: ['ignore', readOutput ? 'pipe' : 'ignore', 'ignore'], ...(signal ? { signal } : {}) })
    let output = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { if (output.length < 4096) output += chunk })
    child.once('error', error => reject(signal?.aborted ? signal.reason
      : (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? new AgentMuxError(`The serving AgentMux environment cannot find the official tailcat CLI in PATH. Install it or make it available to this service, then try again. ${unchanged}`, 'TAILCAT_CLI_MISSING')
        : unavailable('The official tailcat CLI could not start.')))
    child.once('close', code => resolve({ ok: code === 0, output }))
  })
}

const exists = (path: string) => access(path).then(() => true, () => false)

/** Prepare one saved key through the official CLI: create it only when missing, never overwrite or rewrite an existing key. */
export async function prepareTailcatKey(input: { role: TailcatKeyRole; key: string },
  options: { environment?: NodeJS.ProcessEnv; prepareEnvironment?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<TailcatKeyPreparation> {
  const { role, key } = input
  try { await options.prepareEnvironment?.() }
  catch { throw unavailable('Preparing the Tailcat execution environment failed.') }
  const environment = tailcatEnvironment(options.environment ?? process.env)
  const path = tailcatKeyPath(key, environment)
  let created = false
  if (!await exists(path)) {
    // The official CLI checks existence before generating, then writes without O_EXCL.
    // Generate privately on the same filesystem and publish with an atomic, non-replacing link.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = await mkdtemp(join(dirname(path), '.agentmux-key-'))
    try {
      const staged = join(temporary, 'key.private.json')
      const generated = await runTailcat(role === 'server' ? ['genkey', '--key=' + staged, '--fixed-region'] : ['genkey', '--client', '--key=' + staged],
        environment, false, options.signal)
      if (!generated.ok) {
        throw unavailable(`The official tailcat CLI could not create the ${role} key ${key}.` +
          (role === 'server' ? ' A server key picks its DERP region now, so check this Mac\'s network and try again.' : ' Try again.'))
      }
      try { await link(staged, path); created = true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable('Saving the prepared Tailcat key failed. Try again.')
        // Another process published first. Its original key remains authoritative.
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  if (role === 'server') {
    try { await validateServerKey(key, environment) }
    catch { throw new AgentMuxError(`The saved Tailcat key ${key} is not a server key with a PSK and fixed DERP region. Choose another name. ${unchanged}`, 'TAILCAT_KEY_CONFLICT') }
    return { role, key, created }
  }
  const printed = await runTailcat(['--key=' + key, 'printpub'], environment, true, options.signal)
  const publicKey = printed.output.trim()
  if (!printed.ok || !isTailcatNodePublicKey(publicKey)) {
    throw new AgentMuxError(`The saved Tailcat key ${key} has no readable client public key. Choose another name. ${unchanged}`, 'TAILCAT_KEY_CONFLICT')
  }
  return { role, key, created, publicKey }
}
