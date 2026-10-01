import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = join(root, '.tmp/agentmux-private-mobile-client/private-access')
await mkdir(evidence, { recursive: true })
const taskTemp = join(evidence, 'tmp'); await mkdir(taskTemp, { recursive: true })
const sourcePath = 'apps/host/src/private-access.ts'
const source = await readFile(join(root, sourcePath), 'utf8')
const assetsSource = await readFile(join(root, 'apps/host/src/private-access-assets.ts'), 'utf8')
const sourceSha256 = createHash('sha256').update(source).digest('hex')
const mutations = [
  ['post-requires-origin', "if (request.method !== 'GET' && origin !== this.origin) throw denied()", 'if (false) throw denied()'],
  ['host-credential-binding', 'this.authority.authenticate(hostId, credential)', 'this.authority.authenticate(this.authority.hostId, credential)'],
  ['httponly-secret', '; Secure; HttpOnly; SameSite=Strict;', '; Secure; SameSite=Strict;'],
  ['browser-secret-boundary', 'return json(200, state, [cookieHeader(DEVICE_COOKIE', 'return json(200, { ...state, credential: claimed.credential }, [cookieHeader(DEVICE_COOKIE'],
  ['device-principal-binding', 'id: `${this.authority.hostId}:${device.deviceId}`', 'id: `${this.authority.hostId}:wrong-device`'],
  ['native-browser-boundary', "transport !== 'native' || request.headers.has('origin') || request.headers.has('cookie')", "transport !== 'native' || request.headers.has('cookie')"],
  ['assets-leave-rpc', "if (request.method !== 'GET' && request.method !== 'HEAD') return null", 'if (false) return null', 'private-access-assets.ts'],
  ['assets-host-binding', "request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase()", 'false', 'private-access-assets.ts'],
  ['assets-no-symlink', 'const info = await lstat(file)', "const info = await (await import('node:fs/promises')).stat(file)", 'private-access-assets.ts']
]
function run(config, label, cwd = root) {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', config], {
    cwd, encoding: 'utf8', env: { ...process.env, TMPDIR: taskTemp } })
  rmSync(taskTemp, { recursive: true, force: true }); mkdirSync(taskTemp, { recursive: true, mode: 0o700 })
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return { status: result.status, log, label }
}
const baseline = run('apps/host/vitest.private-access.config.ts', 'baseline')
await writeFile(join(evidence, 'module-baseline.log'), baseline.log)
if (baseline.status !== 0 || !/9 passed/u.test(baseline.log)) throw new Error('Private-access actual HTTPS and assets module proof is RED or empty; see module-baseline.log')
const results = []
if (process.argv.includes('--mutation')) {
  const sandbox = join(evidence, 'mutation-sandbox')
  await rm(sandbox, { recursive: true, force: true })
  try {
    for (const file of ['private-access.ts', 'private-access-assets.ts', 'private-tls.ts', 'private-certificates.ts', 'device-authority.ts']) {
      await mkdir(join(sandbox, 'src'), { recursive: true })
      await cp(join(root, 'apps/host/src', file), join(sandbox, 'src', file))
    }
    await mkdir(join(sandbox, 'test'), { recursive: true })
    await cp(join(root, 'apps/host/test/private-access.test.ts'), join(sandbox, 'test/private-access.test.ts'))
    await cp(join(root, 'apps/host/test/private-access-assets.test.ts'), join(sandbox, 'test/private-access-assets.test.ts'))
    const config = join(sandbox, 'vitest.config.ts')
    await writeFile(config, `import { defineConfig } from 'vitest/config'\nexport default defineConfig({ resolve: { alias: [{ find: /^@agentmux\\/core$/, replacement: ${JSON.stringify(join(root, 'packages/core/src/index.ts'))} }] }, test: { environment: 'node', include: [${JSON.stringify(join(sandbox, 'test/private-access*.test.ts'))}] } })\n`)
    for (const [name, before, after, file = 'private-access.ts'] of mutations) {
      const original = file === 'private-access.ts' ? source : assetsSource
      if (original.split(before).length !== 2) throw new Error(`Mutation target is missing or ambiguous: ${name}`)
      await writeFile(join(sandbox, 'src', file), original.replace(before, after))
      const result = run(config, name)
      await writeFile(join(evidence, `mutant-${name}.log`), result.log)
      if (result.status === 0 || !/(AssertionError|expected .* (to |not to ))/u.test(result.log)
        || /No test files found|Failed to load|Transform failed/u.test(result.log)) throw new Error(`Mutation did not produce an assertion RED: ${name}`)
      results.push({ name, status: 'assertion_red' })
      await writeFile(join(sandbox, 'src', file), original)
    }
    await writeFile(join(sandbox, 'src/private-access.ts'), source)
    const restored = run(config, 'restored')
    await writeFile(join(evidence, 'module-restored.log'), restored.log)
    if (restored.status !== 0 || !/9 passed/u.test(restored.log)) throw new Error('Restored private-access proof is RED or empty')
  } finally { await rm(sandbox, { recursive: true, force: true }) }
}
// This is an admission module proof. Neither a fixture nor a name match claims the
// still-required real public transport/Host consumer, Mac approval or iPhone oracle.
const receipt = { sourcePath, sourceSha256, assetsSourceSha256: createHash('sha256').update(assetsSource).digest('hex'),
  tests: 9, mutations: results, scope: 'admission and finite static assets modules only',
  publicTransportIntegrated: false, realDeviceVerified: false, fullT002Accepted: false }
await writeFile(join(evidence, process.argv.includes('--mutation') ? 'module-proof.json' : 'module-proof-baseline.json'), `${JSON.stringify(receipt, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(receipt)}\n`)
