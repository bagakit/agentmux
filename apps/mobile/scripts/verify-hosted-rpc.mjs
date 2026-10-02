import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..'), root = resolve(mobile, '../..')
const evidence = join(root, '.tmp/agentmux-private-mobile-client/hosted-mobile-rpc')
await mkdir(evidence, { recursive: true })
if (!process.argv.includes('--preparation')) throw new Error('Actual joined Host HTTPS, Mac device confirmation, original Run and real iPhone proof remain required. This adapter evidence cannot sign T002.')
const owned = ['src/connection/hosted-rpc.ts', 'src/main.tsx', 'src/platform/browser.tsx', 'test/hosted-rpc.test.tsx', 'scripts/verify-hosted-rpc.mjs']
const source = await readFile(join(mobile, owned[0]), 'utf8')
const sha = value => createHash('sha256').update(value).digest('hex')
const before = await Promise.all(owned.map(async path => [path, sha(await readFile(join(mobile, path)))]))
const mutations = [
  ['rich-business-error-flattened', 'failure.details, failure.candidates, typeof failure.detail === \'string\' ? failure.detail : undefined', 'undefined, undefined, undefined', 'rich business errors'],
  ['cookie-omitted', "credentials: 'include'", "credentials: 'omit'", 'sole public writer/parser'],
  ['native-fetch-dropped', '...(this.options.fetch ? { fetch: this.options.fetch } : {})', '...{}', 'injected native raw fetch'],
  ['wrong-response-id', 'if (response.id !== id) throw protocol()', 'if (false) throw protocol()', 'wrong response identity'],
  ['foreign-subscription', 'event.subscriptionId !== subscriptionId || event.method !== method || event.sequence !== sequence + 1', 'false', 'subscription method, ID and sequence'],
  ['reader-not-released', 'finish(); await reader?.dispose()', 'await Promise.resolve()', 'another device consumer alive'],
  ['admission-remains-owner', "finally { signal.removeEventListener('abort', abort) }", 'finally {}', 'another device consumer alive'],
  ['retry-lost-write', "if (!handlers) finish()", "if (!handlers) { finish(); void openAgentMuxRpcHttpRequest({ url: this.url, credentials: 'include', ...(this.options.fetch ? { fetch: this.options.fetch } : {}) }, { jsonrpc: '2.0', id, method, params: body }, () => {}, () => {}, new AbortController().signal) }", 'sole public writer/parser']
]
const sandbox = join(evidence, 'mutation-sandbox'), taskTemp = join(evidence, 'tmp')
await mkdir(sandbox, { recursive: true }); await mkdir(taskTemp, { recursive: true })
const config = join(sandbox, 'vitest.config.ts'), file = join(sandbox, 'hosted-rpc.ts')
const hostedEntry = await realpath(join(mobile, 'node_modules/@agentmux/core/dist/hosted.js'))
const httpEntry = await realpath(join(mobile, 'node_modules/@agentmux/core/dist/public-rpc-http.js'))
function run(name, configPath, pattern) {
  const output = join(evidence, `${name}.json`)
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath,
    'test/hosted-rpc.test.tsx', '--maxWorkers=1', '--reporter=json', '--outputFile', output,
    ...(pattern ? ['-t', pattern] : [])]
  const result = spawnSync(process.execPath, args, { cwd: mobile, encoding: 'utf8', env: { ...process.env, TMPDIR: taskTemp } })
  return { exit: result.status, output, log: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}
async function inspect(name, value, red = false) {
  await writeFile(join(evidence, `${name}.log`), value.log)
  const result = JSON.parse(await readFile(value.output, 'utf8'))
  const failed = result.testResults.flatMap(test => test.assertionResults.filter(assertion => assertion.status === 'failed'))
  if (red ? value.exit === 0 || failed.length !== 1 || !failed[0].failureMessages.some(message => message.includes('AssertionError'))
    : value.exit !== 0 || result.numPassedTests !== 10 || failed.length) throw new Error(`Actual nonempty ${red ? 'Source AssertionRED' : 'ten-case GREEN'} absent: ${name}`)
  return { name, exit: value.exit, passed: result.numPassedTests, failed: failed.length, assertionRed: red }
}
const baseline = await inspect('baseline', run('baseline', 'vitest.config.ts'))
const mutationResults = []
try {
  await writeFile(config, `import base from ${JSON.stringify(join(mobile, 'vitest.config.ts'))}\nexport default { ...base, resolve: { ...base.resolve, alias: [{ find: /^(?:\\.\\/|\\.\\.\\/src\\/connection\\/)hosted-rpc$/, replacement: ${JSON.stringify(file)} }, { find: /^@agentmux\\/core\\/hosted$/, replacement: ${JSON.stringify(hostedEntry)} }, { find: /^@agentmux\\/core\\/public-rpc-http$/, replacement: ${JSON.stringify(httpEntry)} }] }, test: { ...base.test, include: [${JSON.stringify(join(mobile, 'test/hosted-rpc.test.tsx'))}] } }\n`)
  // Relative type imports remain type-only; the exact public package remains the original Source.
  if (process.argv.includes('--mutation')) for (const [name, target, replacement, pattern] of mutations) {
    if (source.split(target).length !== 2) throw new Error(`Source mutation is missing or ambiguous: ${name}`)
    await writeFile(file, source.replace(target, replacement))
    mutationResults.push(await inspect(name, run(name, config, pattern), true))
  }
  await writeFile(file, source)
  const restored = await inspect('restored', run('restored', config))
  const main = await readFile(join(mobile, 'src/main.tsx'), 'utf8')
  const connection = await readFile(join(mobile, 'src/connection/MobileConnectionRoot.tsx'), 'utf8')
  const authorityConsumer = await readFile(join(mobile, 'src/connection/private-connection.ts'), 'utf8')
  if (!main.includes("import { connectPrivateHostedClient } from './connection/hosted-rpc'")
    || !main.includes('connectClient={connectPrivateHostedClient}') || !connection.includes('new PrivateConnection(')
    || !authorityConsumer.includes('await this.options.connectClient(')) throw new Error('Original product factory caller is empty or disconnected')
  const after = await Promise.all(owned.map(async path => [path, sha(await readFile(join(mobile, path)))]))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Owned Source changed during isolated evidence generation')
  const shared = ['packages/core/src/public-rpc-http.ts', 'packages/core/src/public-rpc-frame.ts',
    'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-output-observer.ts']
  const receipt = { schema: 'agentmux.mobile-hosted-rpc-preparation.v1', at: new Date().toISOString(),
    ownedSource: Object.fromEntries(before), sharedSource: Object.fromEntries(await Promise.all(shared.map(async path => [path, sha(await readFile(join(root, path)))]))),
    compiledPublicEntries: [{ path: hostedEntry, sha256: sha(await readFile(hostedEntry)) },
      { path: httpEntry, sha256: sha(await readFile(httpEntry)) }],
    baseline, mutations: mutationResults, restored, actualProductCallers: [
      { path: 'apps/mobile/src/main.tsx', sha256: sha(main) },
      { path: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', sha256: sha(connection) },
      { path: 'apps/mobile/src/connection/private-connection.ts', sha256: sha(authorityConsumer) }],
    actualSdkAndSharedHttpConsumer: true, controlledFetchCollaborator: true,
    nativeOsSecretVerified: false, actualMacDialogVerified: false, joinedHostHttpsVerified: false,
    realOriginalRunVerified: false, actualIPhoneVerified: false, fullT002Passed: false, taskDone: false }
  await writeFile(join(evidence, 'preparation.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(`Mobile public adapter: 10 actual SDK/caller cases GREEN, ${mutationResults.length} Source AssertionRED, 10 restored. Real Host/native/device final proof remains absent.\n`)
} finally {
  await rm(sandbox, { recursive: true, force: true }); await rm(taskTemp, { recursive: true, force: true })
}
