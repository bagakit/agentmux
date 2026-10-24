import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { AgentMuxError, connectAgentMuxRpc, defaultAgentMuxMessageQueuePath, defaultAgentMuxStateDirectory, durableWriteFile, type AgentMuxRuntimeOwnerIdentity } from '@agentmux/core'

const exec = promisify(execFile)
const wait = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms))
const failure = (message: string, code = 'HOST_SERVICE_UNCONFIRMED') => new AgentMuxError(message, code)

export type MacosHostService = {
  label: string
  target: string
  plistPath: string
  storePath: string
  socketPath: string
  executable: string
  entrypoint: string
  logPath: string
  environment: Record<string, string>
}
export type MacosHostProcess = { uid: number; pid: number; ppid: number; birth: string }
export type MacosHostServiceOwner = {
  owner: AgentMuxRuntimeOwnerIdentity
  storePath: string
  process: MacosHostProcess
}

export function macosHostServiceAddress(socketPath: string): { label: string; target: string } {
  if (!isAbsolute(socketPath)) throw failure('The service requires its original absolute socket namespace.', 'INVALID_HOST_SERVICE')
  const label = `com.agentmux.host.${createHash('sha256').update(resolve(socketPath)).digest('hex').slice(0, 24)}`
  return { label, target: `gui/${process.getuid!()}/${label}` }
}

/** A reproducible platform description, not another service state or Runtime owner. */
export function macosHostService(input: {
  storePath: string
  socketPath: string
  executable: string
  entrypoint: string
  mobileBuildDirectory: string
  configuration?: { path: string; connectorDirectory: string }
  workspaceMoveHelper?: string
  environment?: Readonly<Record<string, string | undefined>>
}): MacosHostService {
  for (const path of [input.storePath, input.socketPath, input.executable, input.entrypoint, input.mobileBuildDirectory,
    ...(input.configuration ? [input.configuration.path, input.configuration.connectorDirectory] : []),
    ...(input.workspaceMoveHelper ? [input.workspaceMoveHelper] : [])]) {
    if (!isAbsolute(path)) throw failure('The service requires its original absolute namespace and executable paths.', 'INVALID_HOST_SERVICE')
  }
  const { label, target } = macosHostServiceAddress(input.socketPath)
  const environment: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1', AGENTMUX_AGENT_SESSION_STORE: input.storePath,
    AGENTMUX_MOBILE_BUILD_DIRECTORY: input.mobileBuildDirectory,
    ...(input.configuration ? { AGENTMUX_HOST_CONFIGURATION_PATH: input.configuration.path,
      AGENTMUX_MOTE_CONFIGURATION_PATH: input.configuration.path, AGENTMUX_CONNECTOR_DIRECTORY: input.configuration.connectorDirectory } : {}),
    ...(input.workspaceMoveHelper ? { AGENTMUX_WORKSPACE_MOVE_HELPER: input.workspaceMoveHelper } : {})
  }
  // Preserve the exact Runtime authority without persisting an Agent's identity or the caller's environment.
  const inherited = input.environment ?? process.env
  for (const key of ['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'AGENTMUX_SPATIAL_STATE_STORE'] as const) {
    if (inherited[key] !== undefined) environment[key] = inherited[key]!
  }
  return { label, target, plistPath: join(dirname(input.storePath), `${label}.plist`),
    storePath: input.storePath, socketPath: input.socketPath, executable: input.executable,
    entrypoint: input.entrypoint, logPath: join(dirname(input.storePath), 'agentmux-host.log'), environment }
}

const xml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
const string = (value: string) => `<string>${xml(value)}</string>`
export function macosHostServicePlist(service: MacosHostService): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>Label</key>${string(service.label)}
<key>ProgramArguments</key><array>${[service.executable, service.entrypoint, '--store', service.storePath].map(string).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(service.environment).map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`).join('')}</dict>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key>${string(service.logPath)}
<key>StandardErrorPath</key>${string(service.logPath)}
</dict></plist>\n`
}

async function parseServicePlist(plist: string): Promise<unknown> {
  const conversion = exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'],
    { timeout: 5000, maxBuffer: 64 * 1024 })
  const written = new Promise<void>((resolve, reject) => {
    const input = conversion.child.stdin!
    input.once('error', reject)
    input.end(plist, resolve)
  })
  const [result] = await Promise.all([conversion, written])
  return JSON.parse(result.stdout)
}

/** Compare the original service's effective paths, without adopting another target or rewriting it. */
export function normalizeMacosHostServiceDefinition(definition: unknown, storePath: string): unknown {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return definition
  const fields = definition as Record<string, unknown>, environment = fields.EnvironmentVariables
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
    Object.values(environment).some(value => typeof value !== 'string')) return definition
  const original = environment as Record<string, string>
  return { ...fields, EnvironmentVariables: { ...original,
    AGENTMUX_STATE_DIRECTORY: defaultAgentMuxStateDirectory(original),
    // Undefined would borrow this launcher's environment through the helper's default argument.
    AGENTMUX_MESSAGE_QUEUE_PATH: defaultAgentMuxMessageQueuePath(storePath, original.AGENTMUX_MESSAGE_QUEUE_PATH ?? '')
  } }
}

async function launchctl(args: string[]): Promise<string> {
  const result = await exec('/bin/launchctl', args, { timeout: 10_000, maxBuffer: 64 * 1024 })
  return result.stdout
}

/** PID/birth/UID are OS facts; argv and launchctl's diagnostic `print` are not authority. */
export async function inspectMacosHostProcess(pid: number): Promise<MacosHostProcess | null> {
  let stdout: string
  try { stdout = (await exec('/bin/ps', ['-p', String(pid), '-o', 'uid=,pid=,ppid=,lstart='],
    { timeout: 5000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' } })).stdout }
  catch (error) {
    const observed = error as { code?: unknown; stdout?: string; stderr?: string }
    if (observed.code === 1 && !observed.stdout?.trim() && !observed.stderr?.trim()) {
      try { process.kill(pid, 0) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return null; throw cause }
    }
    throw error
  }
  const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(stdout)
  if (!row) throw failure('The original Host OS identity is unknown. Its process and Runs were retained.')
  return { uid: Number(row[1]), pid: Number(row[2]), ppid: Number(row[3]), birth: row[4]! }
}

async function mappedExecutable(pid: number, executable: string): Promise<void> {
  const path = await realpath(executable)
  const { stdout } = await exec('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', String(pid), '-d', 'txt', '-Fn'],
    { timeout: 5000, maxBuffer: 256 * 1024 })
  if (!stdout.split('\n').includes(`n${path}`)) throw failure('The original service process does not map the expected executable. No process was stopped.', 'HOST_SERVICE_IDENTITY_MISMATCH')
}

/** The documented kickstart -p receipt names the current job PID without replacing a live process. */
export async function macosHostServicePid(service: Pick<MacosHostService, 'target'>): Promise<number> {
  const receipt = (await launchctl(['kickstart', '-p', service.target])).trim()
  if (!/^[1-9]\d*$/.test(receipt) || !Number.isSafeInteger(Number(receipt))) throw failure('The platform service PID receipt is unconfirmed. Inspect the original service without replacing it.')
  return Number(receipt)
}

/** `list`'s documented three columns are a machine contract; `print` is diagnostic only. */
export function parseMacosServiceList(output: string): Array<{ label: string; pid: number | null }> {
  const lines = output.trim().split('\n')
  if (lines.length < 2 || !/^PID\s+Status\s+Label$/.test(lines[0]!)) throw failure('The platform service directory is unconfirmed. Existing services were retained.')
  return lines.slice(1).map(line => {
    const row = /^(\d+|-)\s+-?\d+\s+(.+)$/.exec(line.trim())
    if (!row) throw failure('The platform service directory response is invalid. Existing services were retained.')
    const pid = row[1] === '-' ? null : Number(row[1])
    if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) throw failure('The platform service PID is invalid. Existing services were retained.')
    return { label: row[2]!, pid }
  })
}

/** Establish absence in the exact GUI domain, without interpreting stderr or failure exit codes. */
export async function macosHostServiceRegistration(service: Pick<MacosHostService, 'label'>, hostPid?: number): Promise<{ pid: number | null } | null> {
  const manager = async () => (await launchctl(['managername'])).trim() === 'Aqua' &&
    (await launchctl(['manageruid'])).trim() === String(process.getuid!())
  if (!await manager()) throw failure('The service directory is outside the original GUI user domain. No service was changed.')
  const jobs = parseMacosServiceList(await launchctl(['list']))
  if (!await manager()) throw failure('The GUI service domain changed during observation. No service was changed.')
  const original = jobs.find(job => job.label === service.label)
  if (hostPid !== undefined && jobs.some(job => job.pid === hostPid && job.label !== service.label)) throw failure(
    'The original Host belongs to another platform service. Its owner was retained.', 'HOST_SERVICE_IDENTITY_MISMATCH')
  return original ? { pid: original.pid } : null
}

async function publicOwner(service: MacosHostService): Promise<{ owner: AgentMuxRuntimeOwnerIdentity; storePath: string }> {
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: service.socketPath } })
  try {
    const { owner } = await rpc.call('runtime.owner.identity', {})
    const opening = await rpc.call('runtime.bootstrap', { consumerId: 'host-service-observer',
      fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
    if (opening.storePath !== service.storePath || opening.hostProcessId !== owner.processId) throw failure(
      'The service endpoint belongs to another original Store or Host process. Its healthy capabilities were retained.', 'HOST_SERVICE_IDENTITY_MISMATCH')
    return { owner, storePath: opening.storePath }
  } finally { await rpc.dispose() }
}

export async function inspectMacosHostService(service: MacosHostService): Promise<MacosHostServiceOwner> {
  const registration = await macosHostServiceRegistration(service)
  if (!registration?.pid) throw failure('The original platform service is not currently running. Its registration and durable namespace were retained.')
  const pid = registration.pid
  const before = await inspectMacosHostProcess(pid)
  const current = await publicOwner(service)
  if (!before || before.uid !== process.getuid!() || current.owner.processId !== pid) throw failure(
    'The platform service and original semantic owner are not the same process. No process was stopped.', 'HOST_SERVICE_IDENTITY_MISMATCH')
  await mappedExecutable(pid, service.executable)
  const after = await inspectMacosHostProcess(pid)
  if (!after || before.birth !== after.birth || before.uid !== after.uid || before.ppid !== after.ppid) throw failure(
    'The original service process changed during observation. Read its current owner again.')
  return { ...current, process: after }
}

/** Registration failures never kill or replace an existing endpoint. A later caller can observe the same service. */
export async function ensureMacosHostService(service: MacosHostService): Promise<MacosHostServiceOwner> {
  const definition = macosHostServicePlist(service)
  await mkdir(dirname(service.plistPath), { recursive: true, mode: 0o700 })
  const verify = async () => {
    const info = await lstat(service.plistPath)
    if (!info.isFile() || info.uid !== process.getuid!()) throw failure(
      'The original platform service definition changed. Keep its owner and inspect the installation before changing this namespace.', 'HOST_SERVICE_CONFIGURATION_CHANGED')
    const original = await readFile(service.plistPath, 'utf8')
    let matches: boolean
    try {
      const [actual, expected] = await Promise.all([parseServicePlist(original), parseServicePlist(definition)])
      matches = isDeepStrictEqual(normalizeMacosHostServiceDefinition(actual, service.storePath),
        normalizeMacosHostServiceDefinition(expected, service.storePath))
    } catch (cause) {
      throw Object.assign(failure('The original platform service definition could not be verified. Its definition and healthy Agents were retained.',
        'HOST_SERVICE_CONFIGURATION_CHANGED'), { cause })
    }
    if (!matches) throw failure(
      'The original platform service definition changed. Keep its owner and inspect the installation before changing this namespace.', 'HOST_SERVICE_CONFIGURATION_CHANGED')
  }
  try { await verify() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const temporary = `${service.plistPath}.${randomUUID()}`
    try {
      await durableWriteFile(temporary, definition)
      try { await link(temporary, service.plistPath) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await verify() }
    } finally { await rm(temporary, { force: true }) }
  }
  // A same-label job is already the platform's single owner. Absence is a successful
  // scoped directory observation, never a bootstrap error interpreted as nonapplication.
  if (!await macosHostServiceRegistration(service)) await launchctl(['bootstrap', `gui/${process.getuid!()}`, service.plistPath])
  await macosHostServicePid(service)
  const deadline = Date.now() + 10_000
  let observed: unknown
  while (Date.now() < deadline) {
    try {
      await publicOwner(service)
      return await inspectMacosHostService(service)
    } catch (error) {
      observed = error
      if (error instanceof AgentMuxError && error.code === 'HOST_SERVICE_IDENTITY_MISMATCH') throw error
      await wait(50)
    }
  }
  throw new AgentMuxError('The platform service was registered but its original endpoint is not yet confirmed. Reconnect to the same namespace; its Runs were retained.',
    'HOST_SERVICE_UNCONFIRMED', observed instanceof Error ? observed.message : undefined)
}

/** Exact maintenance stop: bootout removes the job before installation can replace its image. */
export async function stopMacosHostService(service: MacosHostService, expected: MacosHostServiceOwner): Promise<void> {
  const current = await inspectMacosHostService(service)
  // RED-LINES: only this maintenance operation is refused on a changed target. Bypassing
  // the check could stop a healthy replacement; its input, Runs and endpoint stay available.
  // Re-observing that original namespace is in-band recovery; unrelated Agents are never gates.
  if (current.owner.runtimeId !== expected.owner.runtimeId || current.owner.ownerInstanceId !== expected.owner.ownerInstanceId ||
    current.process.pid !== expected.process.pid || current.process.birth !== expected.process.birth || current.storePath !== expected.storePath) throw failure(
    'The original service owner changed before installation. Its replacement and Runs were retained.', 'HOST_SERVICE_OWNER_CHANGED')
  await launchctl(['bootout', service.target])
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const process = await inspectMacosHostProcess(expected.process.pid)
    if (!process || process.birth !== expected.process.birth) {
      // The platform description is rebuildable installation data. Session/Runtime
      // stores remain untouched; the candidate writes its own complete definition.
      await rm(service.plistPath, { force: true })
      return
    }
    await wait(50)
  }
  throw failure('The service stop has not been confirmed. Installation must retain the original bundle and namespace.', 'HOST_SERVICE_STOP_UNCONFIRMED')
}
