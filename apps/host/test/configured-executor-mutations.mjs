import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
export const mutations = {
  'leak-original-json-failure': ['apps/host/src/mote-resources.ts', "catch { throw new AgentMuxError('The original Host Executor configuration could not be read. Its saved settings and healthy Agents are retained.', 'EXECUTOR_CONFIGURATION_UNAVAILABLE') }", 'catch (error) { throw error }'],
  'host-reader-omitted': ['apps/host/src/host.ts', '...(configurationPath ? { executorConfigurations: (id?: string) => readConfiguredExecutors(configurationPath, id) } : {}),', ''],
  'configured-default-overwrite': ['packages/core/src/executor-owner.ts', "for (const [id, config] of Object.entries(configured ?? {})) entries.set(id, { config, source: 'configured' })", "for (const [id, config] of Object.entries(configured ?? {})) if (!entries.has(id)) entries.set(id, { config, source: 'configured' })"],
  'unrelated-read-gates-registered': ['packages/core/src/executor-owner.ts', 'if (!selectedId || !Object.hasOwn(configurations, selectedId)) {', 'if (true) {'],
  'exact-reads-all': ['apps/host/src/mote-resources.ts', 'const ids = executorId === undefined ? Object.keys(values) : Object.hasOwn(values, executorId) ? [executorId] : []', 'const ids = Object.keys(values)'],
  'configured-removal-rejected': ['packages/core/src/public-rpc-host-settings.ts', "effectiveExecutor.source === 'registered'", "effectiveExecutor.source !== 'provider-default'"],
  'relative-command-path-guessed': ['packages/core/src/executor-owner.ts', "if (!isAbsolute(config.command) && config.command.includes('/')) return", 'if (false) return'],
  'spatial-uses-app-config': ['apps/host/src/spatial-agent-control.ts', 'else await client.createHostAgentWithDelivery(create)',
    'else await client.createAgentWithDelivery({ ...create, providerId: (raw as any).executors[request.content.executorId].providerId, commandOverride: (raw as any).executors[request.content.executorId].command, args: (raw as any).executors[request.content.executorId].args, env: (raw as any).executors[request.content.executorId].env })'],
  'local-caller-lost': ['apps/host/src/spatial-agent-control.ts', "if (request.caller) await client.createLocalHostAgentWithDelivery(create, { agentSessionId: request.caller.agentSessionId, capability: request.caller.capability ?? '' })", 'if (request.caller) await client.createHostAgentWithDelivery(create)'],
  'local-run-fence-lost': ['packages/core/src/client.ts', 'if (execution.sources && (!isDeepStrictEqual(execution.sources.author?.run, author?.run) ||', 'if (false && (!isDeepStrictEqual(execution.sources.author?.run, author?.run) ||'],
  'local-sdk-exported': ['packages/core/src/hosted-client-contract.ts', "'removeHostExecutor', 'createHostAgentWithDelivery',", "'removeHostExecutor', 'createHostAgentWithDelivery', 'createLocalHostAgentWithDelivery',"],
  'setup-freeze-rejected': ['packages/core/src/mote-dialogue-contract.ts', "const execution = rpcRecord(raw.execution,['hostId','workspacePath','workspaceId','runtimeId','executorRevision'],code)", "const execution = rpcRecord(raw.execution,['hostId','workspacePath','workspaceId'],code)"]
}
export function instrument(source, path, surface) {
  if (!/^(?:packages\/core|apps\/host)\/src\/.*\.ts$/u.test(path)) return source
  const original = source, name = process.env.MOTE_CONFIGURED_MUTANT, mutant = name && mutations[name]
  if (name && !mutant) throw Error('Unknown configured Executor mutation')
  if (mutant?.[0] === path) {
    if (source.split(mutant[1]).length !== 2) throw Error('Configured Executor mutation has no unique production anchor: ' + name)
    source = source.replace(mutant[1], mutant[2])
  }
  const report = process.env.MOTE_CONFIGURED_LOADED
  if (report) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    const row = { path, surface, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutation: name }) }
    const statement = `import { appendFileSync as __configuredLoaded } from 'node:fs'; __configuredLoaded(${JSON.stringify(report)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n`
    const offset = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0
    source = source.slice(0, offset) + statement + source.slice(offset)
  }
  return source
}
