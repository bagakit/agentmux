/** Original application Host records, shared by client validation and Node consumption. */
export type TailcatListenerConfig = { enabled: boolean; keyFile: string; allowedClients: string[] }
export type TailcatClientConfig = { address: string; keyFile: string }
export type LocalHostConfig = { id: 'local'; kind: 'local'; label: string; tailcat?: TailcatListenerConfig }
export type SshHostConfig = {
  id: string; kind: 'ssh'; label: string; hostname: string
  user?: string; port?: number; identityFile?: string
  remoteCommand?: string; remoteSocketPath?: string
  /** Omitted transport preserves the original SSH-only route. */
  transport?: 'ssh' | 'ssh-tailcat' | 'tailcat'
  tailcat?: TailcatClientConfig
  /** Learned through the original authenticated connection, never an address alias. */
  runtimeId?: string
}
export type HostConfig = LocalHostConfig | SshHostConfig
type FieldPath = (string | number)[]
/** Structural issues preserve field diagnostics without depending on a validation library. */
export type HostConfigurationIssue = { path: FieldPath; message: string } & (
  | { code: 'invalid_type'; expected: 'object' | 'array' | 'string' | 'number' | 'int' }
  | { code: 'invalid_value'; values: string[] }
  | { code: 'too_small'; origin: 'string' | 'number'; minimum: number; inclusive: true }
  | { code: 'too_big'; origin: 'number'; maximum: number; inclusive: true }
  | { code: 'invalid_format'; format: 'starts_with'; prefix: string }
  | { code: 'unrecognized_keys'; keys: string[] }
  | { code: 'custom' }
)
export type HostConfigurationResult<T> = { success: true; data: T } | { success: false; issues: HostConfigurationIssue[] }

export function parseHostConfiguration(value: unknown): HostConfigurationResult<HostConfig> {
  const issues: HostConfigurationIssue[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { success: false,
    issues: [{ code: 'invalid_type', expected: 'object', path: [], message: 'Expected a Host object.' }] }
  const input = value as Record<string, unknown>
  if (input.kind !== 'local' && input.kind !== 'ssh') return { success: false,
    issues: [{ code: 'invalid_value', values: ['local', 'ssh'], path: ['kind'], message: "Invalid discriminator value. Expected 'local' | 'ssh'" }] }
  const required = input.kind === 'local' ? ['label'] : ['id', 'label', 'hostname']
  const optional = input.kind === 'local' ? [] : ['user', 'identityFile', 'remoteCommand', 'remoteSocketPath', 'runtimeId']
  for (const name of [...required, ...optional]) {
    const field = input[name]
    if (field === undefined && !required.includes(name)) continue
    if (typeof field !== 'string') issues.push({ code: 'invalid_type', expected: 'string', path: [name], message: 'Expected a string.' })
    else if (name === 'remoteSocketPath') {
      if (!field.startsWith('/')) issues.push({ code: 'invalid_format', format: 'starts_with', prefix: '/', path: [name], message: 'Remote socket path must start with /.' })
    } else if (!field.length && !(name === 'hostname' && input.transport === 'tailcat')) issues.push({ code: 'too_small', origin: 'string', minimum: 1, inclusive: true, path: [name], message: 'Expected a nonempty string.' })
  }
  if (input.kind === 'local' && input.id !== 'local') issues.push({ code: 'invalid_value', values: ['local'], path: ['id'], message: "Local Host id must be 'local'." })
  if (input.kind === 'ssh' && input.port !== undefined) {
    if (typeof input.port !== 'number' || !Number.isFinite(input.port)) issues.push({ code: 'invalid_type', expected: 'number', path: ['port'], message: 'Expected a finite port number.' })
    else if (!Number.isSafeInteger(input.port)) issues.push({ code: 'invalid_type', expected: 'int', path: ['port'], message: 'Port must be an integer.' })
    else if (input.port < 1) issues.push({ code: 'too_small', origin: 'number', minimum: 1, inclusive: true, path: ['port'], message: 'Port must be at least 1.' })
    else if (input.port > 65535) issues.push({ code: 'too_big', origin: 'number', maximum: 65535, inclusive: true, path: ['port'], message: 'Port must be at most 65535.' })
  }
  if (input.kind === 'ssh' && input.transport !== undefined && !['ssh', 'ssh-tailcat', 'tailcat'].includes(input.transport as string)) {
    issues.push({ code: 'invalid_value', values: ['ssh', 'ssh-tailcat', 'tailcat'], path: ['transport'], message: 'Choose SSH, SSH with Tailcat backup, or Tailcat.' })
  }
  const tailcatRequired = input.kind === 'ssh' && (input.transport === 'tailcat' || input.transport === 'ssh-tailcat')
  if (input.tailcat !== undefined || tailcatRequired) {
    const config = input.tailcat
    const problem = (path: FieldPath, message: string) => issues.push({ code: 'custom', path: ['tailcat', ...path], message })
    if (!config || typeof config !== 'object' || Array.isArray(config)) problem([], 'Expected Tailcat configuration.')
    else {
      const tc = config as Record<string, unknown>
      const local = input.kind === 'local'
      const names = local ? ['enabled', 'keyFile', 'allowedClients'] : ['address', 'keyFile']
      const extra = Object.keys(tc).filter(key => !names.includes(key))
      if (extra.length) issues.push({ code: 'unrecognized_keys', keys: extra, path: ['tailcat'], message: 'Tailcat contains unrecognized fields.' })
      if (local && typeof tc.enabled !== 'boolean') problem(['enabled'], 'Tailcat listener enabled must be boolean.')
      const enabled = local ? tc.enabled === true : tailcatRequired
      if (typeof tc.keyFile !== 'string' || /[\0\r\n]/u.test(tc.keyFile) || enabled && !tc.keyFile.trim()) problem(['keyFile'], 'Choose a saved Tailcat key file or key name.')
      if (local) {
        if (!Array.isArray(tc.allowedClients) || tc.allowedClients.some(key => typeof key !== 'string' || !key.trim() || /[\0\r\n,]/u.test(key))) problem(['allowedClients'], 'Allowed clients must be a list of public keys.')
        else if (enabled && tc.allowedClients.length === 0) problem(['allowedClients'], 'Add an allowed client public key before enabling Tailcat.')
      } else if (typeof tc.address !== 'string' || /[\0\r\n]/u.test(tc.address) || enabled && !/^tc[A-Za-z0-9_-]+$/u.test(tc.address)) problem(['address'], 'Enter the private tc address from the other Host.')
    }
  }
  const allowed = new Set(['id', 'kind', ...required, ...optional, 'tailcat', ...(input.kind === 'ssh' ? ['port', 'transport'] : [])])
  const keys = Object.keys(input).filter(key => !allowed.has(key))
  if (keys.length) issues.push({ code: 'unrecognized_keys', keys, path: [], message: 'Host contains unrecognized fields: ' + keys.join(', ') })
  const data: Record<string, unknown> = { id: input.id, kind: input.kind, label: input.label }
  for (const field of [...optional, 'tailcat', ...(input.kind === 'ssh' ? ['hostname', 'port', 'transport'] : [])]) if (field in input) data[field] = input[field]
  return issues.length ? { success: false, issues } : { success: true, data: data as HostConfig }
}

/** The original hosts slice only; unrelated application fields remain with their owner. */
export function parseHostConfigurations(value: unknown): HostConfigurationResult<HostConfig[]> {
  if (!Array.isArray(value)) return { success: false, issues: [{ code: 'invalid_type', expected: 'array', path: [], message: 'Expected the original Hosts array.' }] }
  const hosts: HostConfig[] = [], issues: HostConfigurationIssue[] = []
  for (const [index, entry] of value.entries()) {
    const parsed = parseHostConfiguration(entry)
    if (parsed.success) hosts.push(parsed.data)
    else issues.push(...parsed.issues.map(issue => ({ ...issue, path: [index, ...issue.path] })))
  }
  if (issues.length) return { success: false, issues }
  const ids = new Set(hosts.map(host => host.id))
  if (ids.size !== hosts.length) issues.push({ code: 'custom', path: [], message: 'Host ids must be unique' })
  if (!ids.has('local')) issues.push({ code: 'custom', path: [], message: 'Local host is required' })
  return issues.length ? { success: false, issues } : { success: true, data: hosts }
}
