import { fixturePath } from '../../../test/fixture-values.mjs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import ts from 'typescript'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const exec = promisify(execFile), cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-startup-source-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const entry = join(directory, 'original-index.mjs'), source = resolve('apps/host/src/index.ts')
  await build({ entryPoints: [source], bundle: true, outfile: entry, packages: 'external', platform: 'node', format: 'esm',
    plugins: [{ name: 'capture-only-original-host-startup-port', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\/core$/ }, () => ({ path: resolve('packages/core/dist/index.js'), external: true }))
      if (process.env.AGENTMUX_HOST_STATE_MUTATION === 'startup-source-withdrawn') builder.onLoad({ filter: /index\.ts$/ }, async ({ path }) => {
        expect(path).toBe(source); const bytes = await readFile(path, 'utf8'), block = '  privateAccessConfigurationPath = privatePath'
        expect(bytes.split(block)).toHaveLength(2); console.info('AMX_HOST_STATE_MUTANT:startup-source-withdrawn')
        return { loader: 'ts', contents: bytes.replace(block, '') }
      })
      builder.onResolve({ filter: /^\.\/host\.js$/ }, args => {
        expect(args.importer).toBe(source); return { path: 'original-host-startup', namespace: 'private-port' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'private-port' }, () => ({ loader: 'js', contents:
        `export const agentMuxHostStore = path => ({path});
export async function startAgentMuxHost(options) { return {client:{runtimeIdentity:()=>({capturedOptions:options})},
privateAccessState:()=>({state:'unavailable',message:'Capture-only startup port; no Host or Runtime started.'}),dispose:async()=>{}} }` }))
    } }] })
  const store = join(directory, 'sessions.json')
  async function run(args: string[]) {
    const { stdout, stderr } = await exec(process.execPath, [entry, '--store', store, ...args], {
      cwd: directory, env: objectCliEnvironment(directory, { AGENTMUX_AGENT_SESSION_STORE: store }), timeout: 5000 })
    expect(stderr).toBe(''); return JSON.parse(stdout).identity.capturedOptions as { privateAccessConfigurationPath?: string;
      privateAccessIssue?: string; privateAccess?: unknown }
  }
  return { directory, store, run }
}

/** Actual index/config-reader Source reaches a capture-only Host port. No Core,
 * certificate preparation, TLS handshake, production Host or Run is launched. */
it('forwards the validated original default/explicit manifest source even when reading fails, while malformed argv has no source fact', async () => {
  const f = await fixture(), defaultPath = join(f.directory, 'agentmux-private-access.json'), explicit = join(f.directory, 'explicit.json')
  expect(await f.run([])).toEqual({ store: { path: f.store }, privateAccessConfigurationPath: defaultPath })
  await writeFile(defaultPath, '{original-invalid-manifest')
  const bad = await f.run([])
  expect(bad).toMatchObject({ privateAccessConfigurationPath: defaultPath, privateAccessIssue: expect.stringContaining('configuration is invalid') })
  expect(await readFile(defaultPath, 'utf8')).toBe('{original-invalid-manifest')
  expect(await f.run(['--private-access', explicit])).toMatchObject({ privateAccessConfigurationPath: explicit, privateAccessIssue: expect.stringContaining('ENOENT') })
  const invalid = [['--private-access', 'relative.json'], ['--private-access', fixturePath('bad\u2028manifest')], ['--private-access'],
    ['--private-access', explicit, '--private-access', explicit], ['--private-access', '/' + '界'.repeat(1366)]]
  expect(invalid).toHaveLength(5)
  for (const args of invalid) {
    const observation = await f.run(args)
    expect(observation).not.toHaveProperty('privateAccessConfigurationPath')
    expect(observation).toHaveProperty('privateAccessIssue', expect.stringContaining('one absolute non-secret manifest'))
  }
  const configuration = { host: '127.0.0.1', port: 9443, keyPath: fixturePath("explicit/key.pem"), certificatePath: fixturePath("explicit/certificate.pem") }
  await writeFile(explicit, JSON.stringify(configuration))
  expect(await f.run(['--private-access', explicit])).toEqual({ store: { path: f.store }, privateAccess: configuration, privateAccessConfigurationPath: explicit })
  expect(await readFile(explicit, 'utf8')).toBe(JSON.stringify(configuration))
})

it('connects the existing Desktop Host and certificate helper entries to their original Source without a duplicate script', async () => {
  const path = resolve('apps/desktop/electron.vite.config.ts'), text = await readFile(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), entries: Array<{ name: string; source: string }> = []
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'input' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)
        && ts.isCallExpression(property.initializer)) {
        const value = property.initializer.arguments.at(-1)
        if (value && ts.isStringLiteral(value)) entries.push({ name: property.name.text, source: value.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(entries).toEqual([{ name: 'agentmux-host', source: '../host/src/index.ts' },
    { name: 'prepare-private-access', source: '../host/src/prepare-private-access.ts' }])
  expect((await readFile(resolve('apps/host/src/prepare-private-access.ts'))).byteLength).toBeGreaterThan(0)
})

it('reads the original compiled Host getter locator through actual Authority and Unix caller, omitting only a missing helper', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-host-helper-caller-')))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const caller = join(directory, 'different-caller'); await mkdir(caller)
  await writeFile(join(caller, 'prepare-private-access.js'), 'throw new Error("Unrelated helper must never execute or be selected.")')
  const helper = join(directory, 'prepare-private-access.js'), produced = await readFile(resolve('apps/host/dist/prepare-private-access.js'))
  expect(produced.byteLength).toBeGreaterThan(0); await writeFile(helper, produced)
  const entry = join(directory, 'original-host.mjs'), source = resolve('apps/host/src/host.ts'), core = resolve('packages/core/dist/index.js')
  const mutation = process.env.AGENTMUX_HOST_STATE_MUTATION
  await build({ entryPoints: [source], bundle: true, outfile: entry, packages: 'external', external: [core], platform: 'node', format: 'esm',
    plugins: [{ name: 'isolate-only-core-lifecycle-in-original-host', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\/core$/ }, () => ({ path: 'original-core', namespace: 'private-core-port' }))
      builder.onLoad({ filter: /.*/, namespace: 'private-core-port' }, () => ({ loader: 'js', contents:
        `export * from ${JSON.stringify(core)};
export class AgentMuxClient {async connect(){} async dispose(){}}
export class AgentMuxHostedRuntimeService {async dispose(){}}` }))
      if (mutation === 'host-helper-call-withdrawn') builder.onLoad({ filter: /host\.ts$/ }, async ({ path }) => {
        expect(path).toBe(source); const bytes = await readFile(path, 'utf8'), block = '    const certificatePreparation = readCertificatePreparation()'
        expect(bytes.split(block)).toHaveLength(2); console.info('AMX_HOST_STATE_MUTANT:host-helper-call-withdrawn')
        return { loader: 'ts', contents: bytes.replace(block, '    const certificatePreparation = undefined') }
      })
    } }] })
  const script = `import {startAgentMuxHost,agentMuxHostStore} from ${JSON.stringify(entry)};
import {connectAgentMuxRpc} from ${JSON.stringify(core)};
import {unlink} from 'node:fs/promises';
const host=await startAgentMuxHost({store:agentMuxHostStore(${JSON.stringify(join(directory, 'sessions.json'))}),socketPath:${JSON.stringify(join(directory, 'control.sock'))}});
const client=await connectAgentMuxRpc({endpoint:{transport:'unix',path:${JSON.stringify(join(directory, 'control.sock'))}}});
try {const before=await client.call('device.ls',{});await unlink(${JSON.stringify(helper)});const after=await client.call('device.ls',{});console.log(JSON.stringify({before,after,actualExecutable:process.execPath}));}
finally{await client.dispose();await host.dispose();}`
  const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', script], {
    cwd: caller, env: objectCliEnvironment(directory, { ELECTRON_RUN_AS_NODE: '1' }), timeout: 5000 })
  expect(stderr).toBe('')
  const receipt = JSON.parse(stdout)
  expect(receipt.before.privateAccess).toEqual({ state: 'unconfigured', message: expect.any(String),
    certificatePreparation: { executable: receipt.actualExecutable, entry: helper, electronRunAsNode: false } })
  expect(receipt.after).toEqual({ ...receipt.before, privateAccess: { state: 'unconfigured', message: receipt.before.privateAccess.message } })
  expect(receipt.before.devices).toEqual([]); expect(receipt.before.requests).toEqual([])
})
