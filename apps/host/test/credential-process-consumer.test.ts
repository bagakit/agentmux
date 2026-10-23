import { afterEach, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, mkdir, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
import { sealConnectionCredential } from '../src/credential-administration.js'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { createHostCredentialEncryption } from '../src/credential-encryption.js'
import { credentialSource, credentialSources, credentialSupportingSources } from './credential-source.mjs'

const repository = resolve(import.meta.dirname, '../../..'), disposers: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })
async function rootDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'amux-credential-process-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  return root
}
async function owner(root: string, backend: { key: number[] | null; denied: boolean; writes: number } | 'native') {
  const source = [...credentialSources, ...credentialSupportingSources].map((file: string) => credentialSource(repository, resolve(repository, file))!.receipt)
  const bundle = join(root, 'credential-owner.mjs')
  await symlink(resolve(repository, 'apps/host/node_modules'), join(root, 'node_modules')).catch(error => { if (error.code !== 'EEXIST') throw error })
  await build({ entryPoints: [resolve(import.meta.dirname, 'fixtures/credential-owner.mjs')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@agentmux/connectors', '@napi-rs/keyring', 'fs-native-extensions'], alias: { '@agentmux/core': resolve(import.meta.dirname, 'credential-core-exports.ts'), '@agentmux/identity': resolve(repository, 'packages/identity/src/index.ts') },
    define: { __CREDENTIAL_SOURCE_RECEIPTS__: JSON.stringify(source) }, plugins: [{ name: 'credential-owning-source', setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async args => { const loaded = credentialSource(repository, args.path); return loaded ? { contents: loaded.contents, loader: loaded.loader } : undefined })
    } }] })
  const bundleSha256 = createHash('sha256').update(await readFile(bundle)).digest('hex')
  const child = fork(bundle, [root, backend === 'native' ? 'native' : 'injected'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' } })
  let sequence = 0, stderr = ''
  const pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>()
  child.stderr!.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096) })
  let ready!: (value: any) => void, failed!: (error: unknown) => void
  const started = new Promise<any>((accept, reject) => { ready = accept; failed = reject })
  child.on('message', (message: any) => {
    if (message.kind === 'ready') { ready(message); return }
    if (message.kind === 'keyring') {
      if (backend === 'native') throw Error('Native consumer requested an injected provider')
      const denied = backend.denied
      if (!denied && message.method === 'set') { backend.key = [...message.bytes]; backend.writes++ }
      child.send({ kind: 'keyring-result', id: message.id, denied, value: message.method === 'get' ? backend.key && [...backend.key] : null }); return
    }
    const handler = pending.get(message.id); if (!handler) return
    pending.delete(message.id)
    if (message.error) handler.reject(message.error); else handler.resolve(message.value)
  })
  child.once('exit', code => { const error = Error(`Synthetic credential owner exited ${code}: ${stderr}`); failed(error); for (const handler of pending.values()) handler.reject(error) })
  const stop = async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = new Promise<void>(done => child.once('exit', () => done())); child.disconnect(); child.kill('SIGTERM'); await exited }
  disposers.push(stop)
  const initial = await started
  expect(initial.source).toEqual(source)
  if (process.env.AGENTMUX_CREDENTIAL_PROCESS_REPORT) await appendFile(process.env.AGENTMUX_CREDENTIAL_PROCESS_REPORT, JSON.stringify({ kind: 'loaded-owner', pid: initial.pid, target: initial.target, bundleSha256, source }) + '\n')
  return { ...initial, stop, call: (operation: string, input: Record<string, unknown> = {}): Promise<any> => new Promise((accept, reject) => { const id = ++sequence; pending.set(id, { resolve: accept, reject }); child.send({ id, operation, ...input }) }) }
}

it('executes sealed storage and resolution in a separate Node owner, then restarts over the same vault', async () => {
  const root = await rootDirectory(), backend = { key: null as number[] | null, denied: false, writes: 0 }, first = await owner(root, backend)
  expect(first.pid).not.toBe(process.pid)
  const key = await first.call('key'), original = { operationId: 'original-process-operation', secret: 'synthetic-process-private-secret' }, sealed = sealConnectionCredential({ key, ...original })
  const receipt = await first.call('store', { input: sealed })
  expect(await first.call('resolve', receipt)).toBe(original.secret)
  expect(await first.call('inspect', { operationId: original.operationId })).toEqual(receipt)
  await first.stop()
  const restarted = await owner(root, backend)
  expect(restarted.target.ownerInstanceId).not.toBe(first.target.ownerInstanceId)
  expect(await restarted.call('inspect', { operationId: original.operationId })).toEqual(receipt)
  expect(await restarted.call('resolve', receipt)).toBe(original.secret)
  await expect(restarted.call('store', { input: sealed })).rejects.toMatchObject({ code: 'INVALID_CONNECTION_CREDENTIAL_ENTRY' })
  expect(await restarted.call('store', { input: sealConnectionCredential({ key: await restarted.call('key'), ...original }) })).toEqual(receipt)
  backend.denied = true
  await expect(restarted.call('resolve', receipt)).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
  expect(await restarted.call('inspect', { operationId: original.operationId })).toEqual(receipt)
  backend.denied = false
  expect(await restarted.call('resolve', receipt)).toBe(original.secret)
  expect(backend.writes).toBe(1)
  const database = new DatabaseSync(join(root, 'connections.sqlite'))
  try { expect(Buffer.from(database.prepare('SELECT ciphertext FROM connection_credential').get()!.ciphertext as Uint8Array).includes(Buffer.from(original.secret))).toBe(false) } finally { database.close() }
}, 30_000)

it('does not overwrite a master key while another exact database initializer holds its namespace lease', async () => {
  const root = await rootDirectory(), backend = { key: null as number[] | null, denied: false, writes: 0 }, holder = await owner(root, backend)
  expect(await holder.call('lock')).toBe(true)
  const database = new DatabaseSync(join(root, 'connections.sqlite'))
  const encryption = createHostCredentialEncryption({ database, namespace: root, keyring: async () => ({ getSecret: async () => backend.key && [...backend.key], setSecret: async bytes => { backend.key = [...bytes]; backend.writes++ } }) })
  const secrets = new ConnectionSecrets(database, encryption)
  try {
    await expect(secrets.store({ operationId: 'contending-operation', secret: 'synthetic-lock-secret' })).rejects.toMatchObject({ code: 'CONNECTION_CREDENTIAL_UNAVAILABLE' })
    expect(backend.writes).toBe(0)
    expect(await secrets.inspect('contending-operation')).toBeNull()
    await holder.call('unlock')
    const receipt = await secrets.store({ operationId: 'contending-operation', secret: 'synthetic-lock-secret' })
    expect(await secrets.resolve(receipt.credentialRef)).toBe('synthetic-lock-secret')
  } finally { database.close() }
}, 30_000)

it.skipIf(!process.env.AGENTMUX_CREDENTIAL_NATIVE_PROOF)('reports actual native OS support separately from the injected process proof', async () => {
  const root = await rootDirectory(), first = await owner(root, 'native'), original = { operationId: 'native-synthetic-operation', secret: 'native-synthetic-secret' }
  const report: Record<string, unknown> = { platform: process.platform, architecture: process.arch, provider: 'native-os-keyring', supported: false }
  let current = first
  try {
    const receipt = await first.call('store', { input: sealConnectionCredential({ key: await first.call('key'), ...original }) })
    expect(await first.call('resolve', receipt)).toBe(original.secret)
    await first.stop()
    current = await owner(root, 'native')
    expect(await current.call('inspect', { operationId: original.operationId })).toEqual(receipt)
    expect(await current.call('resolve', receipt)).toBe(original.secret)
    report.supported = true; report.receipt = receipt
  } catch (error) { report.failure = error && typeof error === 'object' && 'code' in error ? error.code : 'NATIVE_PROOF_FAILED'; if (report.failure !== 'CONNECTION_CREDENTIAL_UNAVAILABLE') throw error }
  finally {
    try { report.syntheticKeyRemoved = await current.call('remove-synthetic-key') } catch { report.syntheticKeyRemoved = 'unconfirmed' }
    if (process.env.AGENTMUX_CREDENTIAL_PROCESS_REPORT) await appendFile(process.env.AGENTMUX_CREDENTIAL_PROCESS_REPORT, JSON.stringify({ kind: 'native-platform', ...report }) + '\n')
  }
  expect(report.supported === true || report.failure === 'CONNECTION_CREDENTIAL_UNAVAILABLE').toBe(true)
}, 30_000)
