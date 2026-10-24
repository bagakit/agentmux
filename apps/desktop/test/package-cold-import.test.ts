import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const exec = promisify(execFile)
const repository = resolve(import.meta.dirname, '../../..')
const sourceRoot = process.env.AGENTMUX_COLD_IMPORT_SOURCE_ROOT ?? repository
const evidence = process.env.AGENTMUX_COLD_IMPORT_EVIDENCE
const roots: string[] = []
const owners = ['package-macos.mjs', 'package-runtime-upgrade.mjs', 'package-semantic-host.mjs', 'macos-local-signing.mjs']
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  // Outside the repository: neither its ancestor node_modules nor Core dist can
  // satisfy this checkout's exact workspace package link.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-package-cold-'))); roots.push(root)
  const checkout = join(root, 'checkout'), desktop = join(checkout, 'apps/desktop')
  const scripts = join(desktop, 'scripts'), core = join(checkout, 'packages/core')
  await mkdir(scripts, { recursive: true }); await mkdir(join(core, 'src'), { recursive: true })
  for (const name of await readdir(join(sourceRoot, 'apps/desktop/scripts'))) if (name.endsWith('.mjs')) {
    await cp(join(sourceRoot, 'apps/desktop/scripts', name), join(scripts, name))
  }
  await cp(join(sourceRoot, 'apps/desktop/src/shared'), join(desktop, 'src/shared'), { recursive: true })
  await cp(join(sourceRoot, 'apps/desktop/package.json'), join(desktop, 'package.json'))
  await cp(join(sourceRoot, 'packages/core/package.json'), join(core, 'package.json'))
  await cp(join(sourceRoot, 'packages/core/src/socket-liveness.ts'), join(core, 'src/socket-liveness.ts'))
  await writeFile(join(checkout, 'package.json'), '{"private":true,"type":"module"}\n')
  await writeFile(join(checkout, '.gitignore'), 'node_modules/\n')
  await mkdir(join(checkout, 'node_modules/@agentmux'), { recursive: true })
  await symlink(core, join(checkout, 'node_modules/@agentmux/core'))
  expect(await realpath(join(checkout, 'node_modules/@agentmux/core'))).toBe(core)
  for (const dependency of ['@electron/osx-sign', 'zod']) {
    const destination = join(checkout, 'node_modules', dependency)
    await mkdir(dirname(destination), { recursive: true })
    await symlink(await realpath(join(repository, 'apps/desktop/node_modules', dependency)), destination)
  }
  const env = { HOME: join(root, 'home'), PATH: process.env.PATH, TMPDIR: root,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  await mkdir(env.HOME)
  await exec('git', ['init', '--quiet', checkout], { env })
  await exec('git', ['-C', checkout, 'add', '.'], { env })
  await exec('git', ['-C', checkout, '-c', 'user.name=Package fixture', '-c', 'user.email=package@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Private cold packaging source'], { env })
  expect((await exec('git', ['-C', checkout, 'status', '--porcelain'], { env })).stdout).toBe('')
  await expect(readFile(join(core, 'dist/object-id.js'))).rejects.toMatchObject({ code: 'ENOENT' })
  const audit = join(root, 'audit.ndjson'), guard = join(root, 'guard.mjs')
  await writeFile(guard, `import cp from 'node:child_process';import {appendFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';import {registerHooks,syncBuiltinESMExports} from 'node:module';
const record=value=>appendFileSync(${JSON.stringify(audit)},JSON.stringify(value)+'\\n');
for(const name of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'])cp[name]=(...args)=>{record({kind:'forbidden-command',name,args});throw Error('Cold preflight attempted a native/build command')};
syncBuiltinESMExports();registerHooks({load(url,context,next){const result=next(url,context);if(url.startsWith(${JSON.stringify(new URL('file://' + checkout + '/').href)})){record({kind:'loaded',url,sha256:createHash('sha256').update(readFileSync(new URL(url))).digest('hex')})}return result},resolve(specifier,context,next){if(specifier==='@agentmux/core/object-id')record({kind:'allocator-resolution',parentURL:context.parentURL});return next(specifier,context)}});\n`)
  const run = async (label: string, args: string[]) => {
    await writeFile(audit, '')
    const before = await exec('git', ['-C', checkout, 'status', '--porcelain'], { env })
    const result = await exec(process.execPath, ['--import', guard, ...args], { cwd: checkout, env, timeout: 10_000, maxBuffer: 256 * 1024 }).then(
      value => ({ stdout: value.stdout, stderr: value.stderr, exitCode: 0, signal: null as string | null }),
      error => ({ stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), exitCode: error.code, signal: error.signal ?? null })
    )
    const calls = (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const status = (await exec('git', ['-C', checkout, 'status', '--porcelain'], { env })).stdout
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, label + '.json'), JSON.stringify({ label, checkout, args, envKeys: Object.keys(env),
        privateCorePath: core, originalSource: sourceRoot, sourcePins: Object.fromEntries(await Promise.all(owners.map(async name =>
          [name, digest(await readFile(join(scripts, name)))]))), before: before.stdout, after: status, ...result, calls }, null, 2) + '\n')
    }
    expect(calls.filter(call => call.kind === 'forbidden-command'), 'Actual package preflight must precede every native/build command').toEqual([])
    expect(result.signal).toBeNull()
    expect(status, 'Actual preflight must leave its clean package source unchanged').toBe(before.stdout)
    return { ...result, calls }
  }
  return { checkout, scripts, core, root, run }
}

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('reaches original signing preflight from the clean actual entry without generated Core output', async () => {
  const f = await fixture()
  for (const [label, args, message] of [
    ['ad-hoc-install', ['--ad-hoc', '--install'], 'Ad hoc signing cannot install the canonical App'],
    ['absent-identity', [], 'Stable macOS delivery requires an exact certificate SHA1']
  ] as const) {
    const result = await f.run(label, [join(f.scripts, 'package-macos.mjs'), ...args])
    expect(result.exitCode).toBe(1)
    expect(result.stderr, 'The actual cold package child must reach its original signing guard, not fail module loading').toContain(message)
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    expect(result.calls.filter(call => call.kind === 'allocator-resolution')).toEqual([])
    for (const owner of owners) expect(result.calls.some(call => call.kind === 'loaded' && call.url.endsWith('/' + owner))).toBe(true)
  }
})

it('loads the actual helpers and reads signing configuration cold, while allocator failure stays explicit at a real producer', async () => {
  const f = await fixture(), signing = new URL('file://' + join(f.scripts, 'macos-local-signing.mjs')).href
  const result = await f.run('helpers-cold', ['--input-type=module', '--eval',
    `${owners.slice(1).map(name => `await import(${JSON.stringify(new URL('file://' + join(f.scripts, name)).href)})`).join(';')};
const signing=await import(${JSON.stringify(signing)});console.log(JSON.stringify(await signing.readLocalSigningIdentity({home:${JSON.stringify(join(f.root, 'home'))}})))`])
  expect(result.exitCode).toBe(0); expect(result.stdout.trim()).toBe('null')
  expect(result.calls.filter(call => call.kind === 'allocator-resolution')).toEqual([])
  const failed = await f.run('new-signing-needs-core', ['--input-type=module', '--eval',
    `const {setupLocalSigningIdentity}=await import(${JSON.stringify(signing)});await setupLocalSigningIdentity({home:${JSON.stringify(join(f.root, 'home'))}})`])
  expect(failed.exitCode).toBe(1); expect(failed.stderr).toContain('ERR_MODULE_NOT_FOUND')
  expect(failed.stderr).toContain(join(f.checkout, 'node_modules/@agentmux/core/dist/object-id.js'))
  await expect(readFile(join(f.root, 'home/.agentmux/signing/identity.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('uses the built public allocator for fenced Semantic Host observation without an unowned consumer release', async () => {
  const f = await fixture(), port = join(f.root, 'rpc-port'), calls = join(f.root, 'rpc-calls.ndjson')
  const failure = join(f.root, 'rpc-failure.txt')
  await mkdir(port)
  await writeFile(join(port, 'public-rpc.js'), 'export const AGENTMUX_RPC_NATIVE_METHODS={"runtime.owner.identity":true}\n')
  await writeFile(join(port, 'public-rpc-client.js'), `import {appendFileSync,existsSync,readFileSync} from 'node:fs';
const failure=existsSync(${JSON.stringify(failure)})?readFileSync(${JSON.stringify(failure)},'utf8'):null;
const record=value=>appendFileSync(${JSON.stringify(calls)},JSON.stringify(value)+'\\n');
export async function connectAgentMuxRpc(){record({kind:'connect'});return {async call(method,params){record({method,params});
if(method===failure)throw Error('injected '+method+' failure');
if(method==='runtime.release-consumer')throw Error('unowned semantic consumer release');
if(method==='runtime.owner.identity')return {owner:{runtimeId:'fixture-runtime',ownerInstanceId:'fixture-owner'}};
if(method==='runtime.bootstrap')return {hostProcessId:4242,storePath:${JSON.stringify(join(f.root, 'unopened-store.json'))}};
return {}},async dispose(){record({kind:'dispose'});if(failure==='dispose')throw Error('injected dispose failure')}}}\n`)
  const args = [join(f.scripts, 'package-semantic-host.mjs'), '--bootstrap', join(port, 'public-rpc-client.js')]
  const cold = await f.run('bootstrap-needs-core', args)
  expect(cold.exitCode).toBe(1); expect(cold.stderr).toContain('ERR_MODULE_NOT_FOUND')
  await expect(readFile(calls)).rejects.toMatchObject({ code: 'ENOENT' })

  // Use exact existing built public artifacts, not a test allocator or source
  // alias. Only the RPC transport is a declared fixture port; no Store/Host runs.
  await mkdir(join(f.core, 'dist'))
  await cp(join(repository, 'packages/core/dist/object-id.js'), join(f.core, 'dist/object-id.js'))
  const identity = join(f.checkout, 'packages/identity')
  await mkdir(join(identity, 'dist'), { recursive: true })
  await cp(join(repository, 'packages/identity/package.json'), join(identity, 'package.json'))
  await cp(join(repository, 'packages/identity/dist/index.js'), join(identity, 'dist/index.js'))
  await symlink(identity, join(f.checkout, 'node_modules/@agentmux/identity'))
  for (const dependency of ['@noble/hashes', '@scure/base']) {
    const destination = join(f.checkout, 'node_modules', dependency)
    await mkdir(dirname(destination), { recursive: true })
    await symlink(await realpath(join(repository, 'packages/identity/node_modules', dependency)), destination)
  }
  const result = await f.run('bootstrap-built-allocator', args)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ hostProcessId: 4242, storePath: join(f.root, 'unopened-store.json') })
  const protocol = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(protocol.map(value => value.method ?? value.kind)).toEqual([
    'connect', 'runtime.owner.identity', 'runtime.bootstrap', 'dispose'
  ])
  const bootstrap = protocol[2]!
  const { isObjectId } = await import('@agentmux/core/object-id')
  expect(bootstrap.params.consumerId.startsWith('package-host-')).toBe(true)
  expect(isObjectId(bootstrap.params.consumerId.slice('package-host-'.length))).toBe(true)
  expect(bootstrap.params.fence).toEqual({ runtimeId: 'fixture-runtime', ownerInstanceId: 'fixture-owner' })
  expect(result.calls.some(call => call.kind === 'allocator-resolution' && call.parentURL.endsWith('/package-semantic-host.mjs'))).toBe(true)
  await expect(readFile(join(f.root, 'unopened-store.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  if (evidence) await writeFile(join(evidence, 'bootstrap-rpc-protocol.json'), JSON.stringify({ protocol,
    boundary: 'Actual helper and Core/identity allocator; controlled RPC transport only, no Host or Store started.',
    coreObjectIdSha256: digest(await readFile(join(f.core, 'dist/object-id.js'))),
    identitySha256: digest(await readFile(join(identity, 'dist/index.js'))) }, null, 2) + '\n')

  for (const stage of ['runtime.owner.identity', 'runtime.bootstrap', 'dispose']) {
    await writeFile(failure, stage)
    await writeFile(calls, '')
    const failed = await f.run('bootstrap-failed-' + stage, args)
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain('injected ' + stage + ' failure')
    const trace = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(trace.map(value => value.method ?? value.kind)).toEqual(stage === 'runtime.owner.identity'
      ? ['connect', 'runtime.owner.identity', 'dispose']
      : ['connect', 'runtime.owner.identity', 'runtime.bootstrap', 'dispose'])
    if (stage === 'dispose') expect(JSON.parse(failed.stdout)).toEqual({ hostProcessId: 4242, storePath: join(f.root, 'unopened-store.json') })
    else expect(failed.stdout).toBe('')
  }
}, 20_000)
