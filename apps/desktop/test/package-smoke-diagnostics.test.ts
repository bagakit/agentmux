import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, it } from 'vitest'
import { preservePackageSmokeFailure } from '../scripts/package-smoke-context.mjs'

const source = await readFile(process.env.AGENTMUX_PACKAGE_SMOKE_SOURCE ?? new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const mains = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === 'main')
if (mains.length !== 1) throw new Error('Expected one original packaging entry')
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-package-diagnostics-')); roots.push(root); return root
}

async function executeOriginalMain(appOnly: boolean, evidenceUnavailable = false, options: { cleanupUnconfirmed?: boolean; stagingRemovalFails?: boolean } = {}) {
  const root = await fixture(), repositoryRoot = join(root, 'repository')
  const originalLog = join(root, 'original-user.log')
  await writeFile(originalLog, 'original user bytes retained')
  const failure = Object.assign(new AggregateError([new Error('ready-receipt: Host identity unknown'), new Error('private Runtime cleanup unknown')], 'Original verification failed'),
    { transaction: { operationId: 'original-install-operation', ui: { status: 'unknown' } },
      ...(options.cleanupUnconfirmed ? { privateSmokeCleanup: { status: 'unconfirmed', hostStopped: false } } : {}) })
  const stagingRemovalError = Object.assign(new Error('Private staging is still occupied'), { code: 'ENOTEMPTY' })
  let staging = '', receipt: Awaited<ReturnType<typeof preservePackageSmokeFailure>> | undefined, output = ''
  const verification = async (_app: string, temporary: string) => {
    staging = temporary
    const privateRoot = appOnly ? temporary : join(temporary, 'verification')
    await mkdir(join(privateRoot, 'user-data'), { recursive: true })
    await writeFile(join(privateRoot, 'user-data/agentmux-host.log'), 'original private Host pre-listen failure')
    await writeFile(join(privateRoot, 'desktop-stderr.log'), 'original private Desktop failure')
    throw failure
  }
  const noop = async () => {}
  const ports = {
    assert: (value: unknown, message: string) => { if (!value) throw new Error(message) },
    process: { argv: [], platform: 'darwin', arch: 'arm64', execPath: join(root, 'bin/node'),
      stderr: { write: (value: string) => { output += value } }, stdout: { write: () => {} } },
    preflightMacosSigning: async () => ({ kind: 'certificate' }), sourceIdentity: async () => ({ commit: 'original-source', tree: 'original-tree', status: '' }),
    require: { resolve: () => join(root, 'electron/package.json') }, dirname, join, mkdir, mkdtemp,
    tmpdir: () => root, run: async () => ({ stdout: '', stderr: '' }), pathExists: async () => true,
    repositoryRoot, desktopRoot: join(repositoryRoot, 'apps/desktop'), releaseRoot: join(root, 'release'),
    PRODUCT_NAME: 'AgentMux', manifest: { version: '0.1.0' }, appOnly, installRequested: false,
    brandApplication: noop, copyRuntimeApplication: noop, verifyIdentity: noop, verifyThirdPartyNotices: noop,
    verifyNativeDesktopCopy: noop, verifyNativeDesktopSigning: noop,
    auditBundleSymlinks: noop, auditRuntimeReferences: noop, verifyWorkspaceMoveHelper: noop,
    signMacosApplication: noop, verifyMacosSigning: async () => ({ kind: 'certificate' }), sha256: async () => 'original-digest',
    verifyPackagedRuntime: noop, createDmg: noop, verifyLaunchServices: verification, verifyDmg: verification,
    rm: async (...args: Parameters<typeof rm>) => {
      if (options.stagingRemovalFails && args[0] === staging) throw stagingRemovalError
      return await rm(...args)
    },
    preservePackageSmokeFailure: async (...args: Parameters<typeof preservePackageSmokeFailure>) => {
      if (evidenceUnavailable) throw new Error('Evidence storage unavailable')
      return receipt = await preservePackageSmokeFailure(...args)
    }
  }
  const consume = new Function(...Object.keys(ports), `return (${mains[0]!.getText(ast)})`)(...Object.values(ports))
  const error = await consume().then(() => { throw new Error('The failed smoke must stay failed') }, (error: unknown) => error)
  return { root, repositoryRoot, staging, receipt, failure, error, output, originalLog, stagingRemovalError }
}

it.each([true, false])('the original package entry preserves exact private failure evidence before removing staging, app-only=%s', async appOnly => {
  const result = await executeOriginalMain(appOnly)
  expect(result.error).toBe(result.failure)
  await expect(stat(result.staging)).rejects.toMatchObject({ code: 'ENOENT' })
  const receipt = result.receipt!
  expect(receipt.directory.startsWith(join(result.repositoryRoot, '.local/state/package-failures/'))).toBe(true)
  expect(receipt.failures.map(row => row.message)).toEqual(result.failure.errors.map(row => row.message))
  const file = receipt.files.find(row => row.source === `${appOnly ? 'app' : 'dmg'}/user-data/agentmux-host.log`)!
  expect(file, 'The original private Host log must survive staging cleanup').toBeDefined()
  expect(file.status).toBe('complete')
  expect(await readFile(join(receipt.directory, file.file!), 'utf8')).toBe('original private Host pre-listen failure')
  expect(receipt.files.some(row => row.status === 'unavailable')).toBe(true)
  expect((await stat(receipt.directory)).mode & 0o777).toBe(0o700)
  expect((await stat(join(receipt.directory, file.file!))).mode & 0o777).toBe(0o600)
  expect(result.output).toContain(`package_failure_diagnostics=${receipt.directory}`)
  expect(await readFile(result.originalLog, 'utf8')).toBe('original user bytes retained')
})

it('retains the original staging and both errors when evidence storage itself fails', async () => {
  const result = await executeOriginalMain(true, true)
  expect(result.error).toBeInstanceOf(AggregateError)
  expect((result.error as AggregateError).errors[0]).toBe(result.failure)
  expect((result.error as AggregateError).errors[1].message).toBe('Evidence storage unavailable')
  expect((result.error as AggregateError & { transaction: unknown }).transaction).toBe(result.failure.transaction)
  expect((await stat(result.staging)).isDirectory()).toBe(true)
})

it('retains the App image when an exact private cleanup remains unconfirmed', async () => {
  const result = await executeOriginalMain(false, false, { cleanupUnconfirmed: true })
  expect(result.error).toBe(result.failure)
  await expect(stat(result.staging).then(info => info.isDirectory())).resolves.toBe(true)
  expect(result.receipt).toMatchObject({ cleanup: { status: 'unconfirmed', hostStopped: false } })
  expect(result.output).toContain(`package_failure_staging=${result.staging}`)
})

it('keeps the original failure and transaction when final staging removal also fails', async () => {
  const result = await executeOriginalMain(true, false, { stagingRemovalFails: true })
  expect(result.error).toBeInstanceOf(AggregateError)
  expect(result.error).toMatchObject({ cause: result.failure, transaction: result.failure.transaction })
  expect((result.error as AggregateError).errors).toEqual([result.failure, result.stagingRemovalError])
  expect((await stat(result.staging)).isDirectory()).toBe(true)
})

it('marks a bounded log tail honestly and leaves the original bytes alone', async () => {
  const root = await fixture(), staged = join(root, 'staged')
  await mkdir(join(staged, 'user-data'), { recursive: true })
  const body = Buffer.alloc(1024 * 1024 + 37, 'x'); body.write('last original failure', body.length - 21)
  const file = join(staged, 'user-data/agentmux-host.log'); await writeFile(file, body)
  const message = 'ready unknown: ' + 'x'.repeat(20_000)
  const receipt = await preservePackageSmokeFailure(staged, join(root, 'evidence'), new Error(message))
  const row = receipt.files.find(item => item.source === 'app/user-data/agentmux-host.log')!
  expect(row).toMatchObject({ status: 'truncated', offset: 37, sourceBytes: body.length, bytes: 1024 * 1024 })
  expect(await readFile(join(receipt.directory, row.file!))).toEqual(body.subarray(37))
  expect(await readFile(file)).toEqual(body)
  expect(receipt.failures[0]).toMatchObject({ messageTruncated: true, messageChars: message.length })
  expect(receipt.failures[0]!.message.startsWith('ready unknown: ')).toBe(true)
  expect(receipt.failures[0]!.message.length).toBeLessThan(message.length)
})

it('does not follow a private diagnostic symlink into another owner', async () => {
  const root = await fixture(), staged = join(root, 'staged'), original = join(root, 'original.log')
  await mkdir(join(staged, 'user-data'), { recursive: true }); await writeFile(original, 'retained outside log')
  await symlink(original, join(staged, 'user-data/agentmux-host.log'))
  await expect(preservePackageSmokeFailure(staged, join(root, 'evidence'), new Error('ready unknown'))).rejects.toMatchObject({ code: 'ELOOP' })
  expect(await readFile(original, 'utf8')).toBe('retained outside log')
})
