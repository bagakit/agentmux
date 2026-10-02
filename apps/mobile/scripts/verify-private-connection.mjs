import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..'), root = resolve(mobile, '../..')
const evidence = join(root, '.tmp/agentmux-private-mobile-client/private-access/browser')
await mkdir(evidence, { recursive: true })
const taskTemp = join(evidence, 'tmp'); await mkdir(taskTemp, { recursive: true })
const source = await readFile(join(mobile, 'src/connection/private-connection.ts'), 'utf8')
const mutations = [
  ['cross-origin-cookie', "if (!origin.startsWith('https://') || origin !== globalThis.location.origin)", 'if (false)'],
  ['native-requires-bridge', 'if (!this.options.nativeAccess)', 'if (false)'],
  ['approved-is-not-connected', 'if (!this.options.connectClient) return', "if (!this.options.connectClient) { this.publish({ connection: { state: 'connected', message: 'mutant' } }); return }"],
  ['original-host', 'if (this.value.hostId && this.value.hostId !== hostId)', 'if (false)'],
  ['superseded-consumer', 'if (epoch !== this.epoch || signal.aborted) { await client.dispose(); return }', 'if (false) { await client.dispose(); return }'],
  ['durable-host-before-sdk', 'this.options.confirmHost?.({ origin: this.value.origin!, hostId: this.value.hostId! }) ?? null', 'null'],
  ['unknown-claim-no-resend', "if (this.value.nativeRecovery === 'new-invitation') return", 'if (false) return']
]
function run(config) {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', config, 'test/private-connection.test.tsx'], {
    cwd: mobile, encoding: 'utf8', env: { ...process.env, TMPDIR: taskTemp } })
  rmSync(taskTemp, { recursive: true, force: true })
  // Only this process's disposable cache is removed; source and receipts stay intact.
  mkdirSync(taskTemp, { recursive: true, mode: 0o700 })
  return { status: result.status, log: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}
const baseline = run('vitest.config.ts')
await writeFile(join(evidence, 'baseline.log'), baseline.log)
if (baseline.status !== 0 || !/8 passed/u.test(baseline.log)) throw new Error('Mounted private-connection proof is RED or empty')
const results = []
if (process.argv.includes('--mutation')) {
  const sandbox = join(evidence, 'mutation-sandbox'); await mkdir(sandbox, { recursive: true })
  const config = join(sandbox, 'vitest.config.ts'), file = join(sandbox, 'private-connection.ts')
  await writeFile(config, `import base from ${JSON.stringify(join(mobile, 'vitest.config.ts'))}\nexport default { ...base, resolve: { ...base.resolve, alias: [{ find: /^(?:\\.\\/|\\.\\.\\/src\\/connection\\/)private-connection$/, replacement: ${JSON.stringify(file)} }] }, test: { ...base.test, include: [${JSON.stringify(join(mobile, 'test/private-connection.test.tsx'))}] } }\n`)
  try {
    for (const [name, before, after] of mutations) {
      if (source.split(before).length !== 2) throw new Error(`Mutation target missing or ambiguous: ${name}`)
      await writeFile(file, source.replace(before, after))
      const result = run(config); await writeFile(join(evidence, `mutant-${name}.log`), result.log)
      if (result.status === 0 || !/AssertionError/u.test(result.log) || /No test files found|Failed to load|Transform failed/u.test(result.log)) {
        throw new Error(`Browser mutation did not produce assertion RED: ${name}`)
      }
      results.push({ name, status: 'assertion_red' })
    }
    await writeFile(file, source)
    const restored = run(config); await writeFile(join(evidence, 'restored.log'), restored.log)
    if (restored.status !== 0 || !/8 passed/u.test(restored.log)) throw new Error('Restored Browser proof is RED or empty')
  } finally { await rm(sandbox, { recursive: true, force: true }) }
}
const callers = ['src/main.tsx', 'src/connection/MobileConnectionRoot.tsx', 'src/MobileApp.tsx']
const callerSources = await Promise.all(callers.map(path => readFile(join(mobile, path), 'utf8')))
if (!callerSources[0].includes('<MobileConnectionRoot') || !callerSources[1].includes('new PrivateConnection(')
  || !callerSources[1].includes('<MobileApp') || !callerSources[2].includes('onHostAddressSaved?.(address)')) {
  throw new Error('Actual application connection consumer is missing; no empty-caller GREEN')
}
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { sourceSha256: sha(source), callers: callers.map((path, index) => ({ path, sha256: sha(callerSources[index]) })),
  tests: 8, mutations: results, scope: 'mounted connection/admission policy only', sdkFactoryInTests: 'controlled test port',
  publicSdkIntegrated: false, nativeOsSecretVerified: false, realDeviceVerified: false, fullT002Accepted: false }
await writeFile(join(evidence, process.argv.includes('--mutation') ? 'proof.json' : 'proof-baseline.json'), `${JSON.stringify(receipt, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(receipt)}\n`)
