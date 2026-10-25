import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
assert(process.argv.length <= 3, 'Pass at most one fresh evidence directory')
const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'amux-control-mutants-'))
if (process.argv[2]) await mkdir(root, { recursive: false, mode: 0o700 })
const guard = `if (!object(params) || !object(params.caller) || Object.keys(params.caller).length !== 2 ||
        params.caller.agentSessionId !== expected.agentSessionId || !sameSecret(params.caller.capability, expected.capability) ||
        Object.hasOwn(params, 'runtimeFence') || isAgentMuxRpcDeviceMethod(request.method) || request.method.startsWith('runtime.')) throw denied()`
const mutations = [
  ['caller-elevation', guard, 'if (!object(params)) throw denied()'],
  ['batch-members', 'const requests = (Array.isArray(value) ? value : [value]).map(parseRpcRequest)', 'const requests = (Array.isArray(value) ? value.slice(0, 1) : [value]).map(parseRpcRequest)'],
  ['invocation-conflict', 'if (!sameInvocation(original.value, value)) throw denied()', 'if (false) throw denied()'],
  ['fixed-credential', 'caller: { ...(replacement ?? expected) }', 'caller: { ...expected }'],
  ['owner-fence', ' || owner.ownerInstanceId !== original.fence.ownerInstanceId', ''],
  ['generation-qualification', 'generation !== this.currentGeneration || state === this.controlState', 'state === this.controlState'],
  ['frontend-duplicate-id', 'if (pending && incoming.some(', 'if (false && pending && incoming.some('],
  ['resource-duplicate-id', 'if (members.some(member =>', 'if (false && members.some(member =>'],
  ['uncertain-write', 'this.options.onError(unavailable()); connection.socket.destroy()', 'throw unavailable()'],
  ['closed-connection', 'this.closed.has(key) || this.connections.size >= MAX_CONNECTIONS', 'this.connections.size >= MAX_CONNECTIONS'],
]
const candidatePaths = ['packages/core/src/agent-execution-rpc-relay.ts', 'packages/core/test/agent-execution-rpc-relay.test.ts']
const fingerprint = async () => Object.fromEntries(await Promise.all(candidatePaths.map(async path => [path, createHash('sha256').update(await readFile(join(repository, path))).digest('hex')])))
const candidate = await fingerprint()
const receipts = []
for (const [name, from, to] of mutations) {
  const report = join(root, name + '.json'), config = join(root, name + '.config.mjs'), log = join(root, name + '.log')
  await writeFile(config, `let applied=0;export default {root:${JSON.stringify(repository)},plugins:[{name:'exact-relay-mutation',enforce:'pre',transform(source,id){if(!id.endsWith('/agent-execution-rpc-relay.ts'))return;const from=${JSON.stringify(from)};if(source.split(from).length!==2)throw new Error('Mutation source must match exactly once');applied++;return source.replace(from,${JSON.stringify(to)})},buildEnd(){if(applied!==1)throw new Error('Mutation did not reach the exact product module')}}],test:{include:['packages/core/test/agent-execution-rpc-relay.test.ts'],passWithNoTests:false,pool:'forks',maxWorkers:1,reporters:['json'],outputFile:${JSON.stringify(report)}}}`, { mode: 0o600 })
  const child = spawn(resolve(repository, 'packages/core/node_modules/.bin/vitest'), ['run', '--config', config], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => chunks.push(bytes))
  const { exitCode, signal } = await new Promise((resolveClose, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolveClose({ exitCode, signal })) })
  await writeFile(log, Buffer.concat(chunks), { mode: 0o600 })
  const result = JSON.parse(await readFile(report, 'utf8'))
  const failed = result.testResults?.flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'failed') ?? []
  const assertionFailure = failed.some(test => test.failureMessages?.some(message => /AssertionError/u.test(message) || /(?:__VITEST_REJECTS__|__VITEST_RESOLVES__)/u.test(message) && /promise (?:resolved|rejected).*instead of (?:rejecting|resolving)/su.test(message)))
  const killed = Number.isInteger(exitCode) && exitCode !== 0 && result.numTotalTests >= 8 && result.numFailedTests > 0 && assertionFailure
  assert.deepEqual(await fingerprint(), candidate, 'The tested source candidate changed during mutation execution')
  receipts.push({ mutation: name, exitCode, signal, closed: true, killed, totalTests: result.numTotalTests, failedTests: result.numFailedTests, report, log })
  await writeFile(join(root, 'summary.json'), JSON.stringify({ candidate, errors: [], passed: receipts.every(receipt => receipt.killed), complete: receipts.length === mutations.length, mutations: receipts }, null, 2) + '\n', { mode: 0o600 })
  assert(killed, `Mutation ${name} did not fail an executed protocol assertion; retain ${log}`)
}
console.log(JSON.stringify({ passed: true, root, summary: join(root, 'summary.json'), errors: [], mutations: receipts.map(receipt => receipt.mutation) }))
