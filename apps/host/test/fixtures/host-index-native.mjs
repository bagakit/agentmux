// Only synthetic Runtime byte I/O and official SDK network I/O are controlled.
// The process entry, Host composition, Core authority/journal and public endpoint are real compiled code.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../../../..'), index = resolve(root, 'apps/host/dist/index.js')
const sha = value => createHash('sha256').update(value).digest('hex')
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const path = fileURLToPath(url)
  if (!path.endsWith('.js')) return result
  if (path !== index && !path.startsWith(resolve(root, 'packages/core/dist') + '/') && !path.startsWith(resolve(root, 'packages/connectors/dist') + '/')) return result
  const original = String(result.source); let served = original
  const variant = process.env.HOST_INDEX_MUTANT
  const variants = {
    'index-owner-omitted': ['...connectionDirectory === void 0 && moteConfigurationPath === void 0 ? {} : {', '...true ? {} : {'],
    'namespace-mismatch-adopted': ['storeArgument !== -1 && process.argv[storeArgument + 1] !== storePath', 'false']
  }
  if (path === index && variant) {
    const mutation = variants[variant]
    if (!mutation || original.split(mutation[0]).length !== 2) throw Error('Compiled index mutation must match its unique original owner expression')
    served = original.replace(mutation[0], mutation[1])
  }
  const credentialVariant = process.env.HOST_CREDENTIAL_MUTANT
  const credentialMutations = {
    'receiver-lookup-collapsed': ['packages/connectors/dist/connection-receivers.js', "lane.failed = credentialLookupFailure(error) ?? 'check-failed'", "lane.failed = 'check-failed'"],
    'publication-lookup-collapsed': ['packages/connectors/dist/publication-host.js', "reason: credentialLookupFailure(error) ?? 'storage-unconfirmed'", "reason: 'credential-missing'"]
  }
  if (credentialVariant && relative(root, path) === credentialMutations[credentialVariant]?.[0]) {
    const mutation = credentialMutations[credentialVariant]
    if (original.split(mutation[1]).length !== 2) throw Error('Credential diagnosis mutation must match one original lookup boundary')
    served = original.replace(mutation[1], mutation[2])
  }
  if (process.env.HOST_INDEX_TRACE) {
    const receipt = { path: relative(root, path), pid: process.pid, originalSHA: sha(original), servedSHA: sha(served), ...(served !== original ? { mutation: variant ?? credentialVariant } : {}) }
    const witness = "import { appendFileSync as __indexLoad } from 'node:fs'; __indexLoad(" + JSON.stringify(process.env.HOST_INDEX_TRACE) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n'
    const offset = served.startsWith('#!') ? served.indexOf('\n') + 1 : 0
    served = served.slice(0, offset) + witness + served.slice(offset)
  }
  return { ...result, source: served }
} })
const { AgentMuxClient, AgentMuxError } = await import('../../../../packages/core/dist/index.js')
if (process.env.HOST_CREDENTIAL_PLATFORM_ERROR) {
  const { DiscordAdapter } = await import('../../../../packages/connectors/dist/adapters/discord/index.js')
  // A platform failure with an identical structured code is not a private resolver fact.
  for (const name of ['test', 'startReceiver']) DiscordAdapter.prototype[name] = async () => { throw new AgentMuxError('Synthetic platform detail must stay private', 'CONNECTION_CREDENTIAL_FORMAT_UNSUPPORTED') }
}
const factsPath = process.env.HOST_INDEX_NATIVE_FACTS
const facts = existsSync(factsPath) ? JSON.parse(readFileSync(factsPath, 'utf8')) : { cursors: {}, writes: {}, effects: [], lifecycle: [] }
const save = () => writeFileSync(factsPath, JSON.stringify(facts))
AgentMuxClient.prototype.connect = async function () {
  await this.registry.load('local'); this.connected = true
  const run = runId => ({ runId, lifecycleOperationId: null, program: 'claude', args: [], workspacePath: process.env.HOST_INDEX_WORKSPACE,
    pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 3, firstAvailableByte: 0,
    acceptedInputBytes: facts.cursors[runId] ?? 0, nativeService: null })
  this.kernel.isConnected = () => true
  this.kernel.status = async id => run(id)
  this.kernel.identity = () => ({ daemonInstanceId: 'index-native-runtime', protocolVersion: 1, buildIdentity: 'controlled-native' })
  this.kernel.input = async (id, input) => {
    const key = JSON.stringify([id, input.operationId]), digest = sha(input.data), previous = facts.writes[key]
    if (previous) {
      if (digest !== previous.digest || input.expectedByte !== previous.startByte) throw Error('Original Native byte operation changed')
      return { run: run(id), appliedByteRange: { startByte: previous.startByte, endByte: previous.endByte } }
    }
    const startByte = facts.cursors[id] ?? 0
    if (input.expectedByte !== startByte) throw Error('Original Native input cursor changed')
    const endByte = startByte + Buffer.byteLength(input.data)
    facts.writes[key] = { digest, startByte, endByte }; facts.cursors[id] = endByte
    facts.effects.push({ runId: id, operationId: input.operationId, startByte, endByte }); save()
    return { run: run(id), appliedByteRange: { startByte, endByte } }
  }
  this.kernel.observeOutput = async id => ({ run: run(id), gap: null, terminal: { type: 'not-requested' }, resizeRevision: 1, replay: [], close: async () => {} })
  for (const name of ['attach', 'detach', 'stop']) this.kernel[name] = async (...args) => { facts.lifecycle.push({ name, args }); save() }
  this.providers.get('claude').planPromptInput = text => ({ kind: 'single-phase', data: text + '\r' })
}
if (process.env.HOST_INDEX_PLATFORM_ORIGIN) {
  const require = createRequire(resolve(root, 'packages/connectors/package.json'))
  const { DefaultRestOptions } = await import(pathToFileURL(resolve(dirname(require.resolve('@discordjs/rest')), 'index.mjs')).href)
  DefaultRestOptions.makeRequest = async (url, init) => {
    const original = new URL(url)
    if (original.origin !== 'https://discord.com') throw Error('Unexpected native Discord API origin')
    return await fetch(process.env.HOST_INDEX_PLATFORM_ORIGIN + original.pathname + original.search, init)
  }
}
