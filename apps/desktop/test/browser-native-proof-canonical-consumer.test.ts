import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { validateNativeReceipt } from '../scripts/lib/browser-capability-proof-join.mjs'

const source = readFileSync(new URL('../scripts/verify-browser-recovery-restart.mjs', import.meta.url), 'utf8')
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

// Execute the actual two canonical functions and its opt-in try body. Top-level
// preparation, launch, ordinary finally and the opt-in cleanup finally are excluded.
function actualConsumer() {
  const file = ts.createSourceFile('verify-browser-recovery-restart.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  expect(file.parseDiagnostics).toHaveLength(0)
  const functions = ['consumeNativeProof', 'lastReceiptPath'].map(name => {
    const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)
    expect(found).toHaveLength(1)
    expect(found[0]!.body!.statements.length).toBeGreaterThan(0)
    return found[0]!.getText(file)
  })
  const branches = file.statements.filter((node): node is ts.IfStatement => ts.isIfStatement(node)
    && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'AGENTMUX_BROWSER_NATIVE_PROOF_INDEX')
  expect(branches).toHaveLength(1)
  const branch = branches[0]!
  expect(ts.isBlock(branch.thenStatement)).toBe(true)
  const tries = (branch.thenStatement as ts.Block).statements.filter(ts.isTryStatement)
  expect(tries).toHaveLength(1)
  const statements = [...tries[0]!.tryBlock.statements]
  expect(statements).toHaveLength(1)
  const statement = statements[0]!
  expect(ts.isExpressionStatement(statement)).toBe(true)
  const expression = (statement as ts.ExpressionStatement).expression
  expect(ts.isAwaitExpression(expression)).toBe(true)
  const call = (expression as ts.AwaitExpression).expression as ts.CallExpression
  expect(ts.isCallExpression(call)).toBe(true)
  expect(call.expression.getText(file)).toBe('consumeNativeProof')
  expect(call.arguments.map(node => node.getText(file))).toEqual(['process.env.AGENTMUX_BROWSER_NATIVE_PROOF_INDEX'])
  return { functions: functions.join('\n'), condition: branch.expression.getText(file), optInBody: statement.getText(file) }
}

// Explicit contract data for the real complete validator; these byte fixtures and
// in-memory dependencies never sign a Native run, PNG, product state or cleanup.
function fixture() {
  const repositoryRoot = '/tmp/source-native-proof-no-created-root'
  const indexPath = 'proof-index.json', receiptPath = 'original-receipt.json'
  const commit = 'a'.repeat(40)
  const identity = { 'apps/desktop/src/main/browser-view-manager.ts': hash('source contract'), 'apps/desktop/out/main/index.js': hash('build contract') }
  const renderer = { path: 'renderer.png', sha256: hash('renderer contract bytes') }
  const native = { path: 'native.png', sha256: hash('native contract bytes') }
  const workbench = { layouts: { workspace: { root: { type: 'leaf', groupId: 'group' }, activeGroupId: 'group',
    groups: [{ id: 'group', tabOrder: ['tab'], recentTabIds: ['tab'], activeTabId: 'tab' }] } },
    tabs: { tab: { id: 'tab', workspaceId: 'workspace', titleRegionId: 'one',
      layout: { activeRegionId: 'one', root: { type: 'split', direction: 'horizontal', ratio: 0.4,
        first: { type: 'leaf', regionId: 'one' }, second: { type: 'leaf', regionId: 'two' } } },
      regions: { one: { kind: 'browser', browserId: 'a', url: 'https://example.test/a' },
        two: { kind: 'browser', browserId: 'b', url: 'https://example.test/b' } } } } }
  const original: any = { schema: 'agentmux.browser-recovery-restart.v1', case: 'local-recovery',
    completeGate: true, passed: true, failure: null, sourceCommit: commit,
    cleanup: { privateProcessesReaped: true, errors: [], remaining: [], temporaryRootRemoved: true },
    identityBefore: identity, identityAfter: identity, first: { pid: 100 }, second: { pid: 200 },
    firstExit: { exitCode: 0, signal: null }, secondExit: { exitCode: 0, signal: null },
    firstUi: { restored: workbench, sessions: [], expected: { tabId: 'tab', focus: 'one', regions: [
      { regionId: 'one', browserId: 'a', url: 'https://example.test/a' }, { regionId: 'two', browserId: 'b', url: 'https://example.test/b' }] } },
    secondUi: { restored: workbench, sessions: [] }, localRecovery: { kind: 'locator', complete: true },
    visual: { frames: [{ label: 'original-normal', sha256: renderer.sha256,
      nativeBounds: [{ x: 0, y: 0, width: 600, height: 400, webContentsId: 2, browserUrl: 'https://example.test/a' }], nativePage: { ...native,
      captureSource: 'native-browser-webcontents', webContentsId: 2, browserUrl: 'https://example.test/a',
      bounds: { x: 0, y: 0, width: 600, height: 400 }, size: { width: 1200, height: 800 } } }] } }
  const proof = { receipt: { path: receiptPath, sha256: '' }, candidate: { commit, identity },
    frames: [{ label: 'original-normal', renderer, native }] }
  const index: any = { schema: 'agentmux.browser-native-proof-index.v1', cases: { 'local-recovery:locator': proof } }
  const files = new Map<string, Buffer>([[resolve(repositoryRoot, renderer.path), Buffer.from('renderer contract bytes')],
    [resolve(repositoryRoot, native.path), Buffer.from('native contract bytes')]])
  const sync = () => {
    // Intentional whitespace proves the canonical preserves original receipt bytes.
    const bytes = Buffer.from('  ' + JSON.stringify(original, null, 3) + '\n\n')
    files.set(resolve(repositoryRoot, receiptPath), bytes); proof.receipt.sha256 = hash(bytes)
    files.set(resolve(repositoryRoot, indexPath), Buffer.from(JSON.stringify(index, null, 2) + '\n'))
    return bytes
  }
  sync()
  let indexReadCount = 0, changedIndex: Buffer | undefined
  const readFile = vi.fn(async (path: string) => {
    if (path === resolve(repositoryRoot, indexPath) && ++indexReadCount === 2 && changedIndex) return changedIndex
    const bytes = files.get(path)
    if (!bytes) throw new Error(`Missing contract input: ${path}`)
    return bytes
  })
  const writeFile = vi.fn(async (_path: string, _bytes: Buffer) => {})
  const exec = vi.fn(async (_command: string, _args: string[], _options: unknown) => ({ stdout: commit + '\n' }))
  const currentIdentity = vi.fn(async () => identity)
  const validator = vi.fn(validateNativeReceipt)
  const process = { env: { AGENTMUX_BROWSER_NATIVE_PROOF_INDEX: indexPath as string | undefined }, stdout: { write: vi.fn() } }
  const actual = actualConsumer()
  const dependencies = { assert, readFile, resolve, repositoryRoot, digest: hash, exec, identity: currentIdentity,
    validateNativeReceipt: validator, writeFile, join, process, localRecoveryCase: true, localRecoveryKind: 'locator',
    receipt: { case: 'local-recovery' }, framesCase: false, taskDownloadCase: false, downloadCase: false, uploadCase: false,
    demonstrationCase: false, overlayCase: false, taskAssetsCase: false, browserToolsCase: false, structuredCase: false, outcomeCase: false }
  const methods = new Function(...Object.keys(dependencies), `${actual.functions}\nreturn {
    consume: consumeNativeProof, last: lastReceiptPath,
    optIn: async () => { if (${actual.condition}) { ${actual.optInBody} } }
  }`)(...Object.values(dependencies)) as { consume: (path: string) => Promise<void>; last: () => string; optIn: () => Promise<void> }
  return { methods, original, proof, index, files, sync, process, readFile, writeFile, exec, currentIdentity, validator,
    indexPath, receiptPath, repositoryRoot, identity, commit, setChangedIndex: (bytes: Buffer) => { changedIndex = bytes } }
}

describe('actual canonical complete Native proof consumer', () => {
  it('calls the complete export once and writes the exact original receipt bytes after every identity check', async () => {
    const x = fixture(), bytes = x.files.get(resolve(x.repositoryRoot, x.receiptPath))!
    await x.methods.optIn()
    expect(x.validator).toHaveBeenCalledTimes(1)
    const input = x.validator.mock.calls[0]![0]
    expect(input.receipt).toEqual(x.original)
    expect(input.candidate).toEqual(x.proof.candidate)
    expect(input.frames).toEqual(x.proof.frames)
    expect(typeof input.readArtifact).toBe('function')
    expect(x.exec.mock.calls).toEqual([['git', ['rev-parse', 'HEAD'], { cwd: x.repositoryRoot }]])
    expect(x.currentIdentity).toHaveBeenCalledTimes(1)
    expect(x.readFile.mock.calls).toEqual([[resolve(x.repositoryRoot, x.indexPath)], [resolve(x.repositoryRoot, x.receiptPath)],
      [resolve(x.repositoryRoot, 'renderer.png')], [resolve(x.repositoryRoot, 'native.png')], [resolve(x.repositoryRoot, x.indexPath)]])
    expect(x.writeFile.mock.calls).toEqual([[join(x.repositoryRoot, '.tmp', 'browser-local-recovery-locator-last.json'), bytes]])
    expect(x.writeFile.mock.calls[0]![1]).toBe(bytes)
    expect(JSON.parse(bytes.toString()).cleanup).toEqual(x.original.cleanup)
    expect(x.process.stdout.write).toHaveBeenCalledTimes(1)
  })

  it('does not consume anything when the actual explicit environment condition is absent', async () => {
    const x = fixture(); x.process.env.AGENTMUX_BROWSER_NATIVE_PROOF_INDEX = undefined
    await x.methods.optIn()
    expect(x.readFile).not.toHaveBeenCalled()
    expect(x.validator).not.toHaveBeenCalled()
    expect(x.writeFile).not.toHaveBeenCalled()
    expect(x.exec).not.toHaveBeenCalled()
  })

  it.each([
    ['missing exact scenario', (x: ReturnType<typeof fixture>) => { delete x.index.cases['local-recovery:locator']; x.sync() }, 'this exact scenario'],
    ['receipt SHA mismatch', (x: ReturnType<typeof fixture>) => { x.sync(); x.proof.receipt.sha256 = 'b'.repeat(64); x.files.set(resolve(x.repositoryRoot, x.indexPath), Buffer.from(JSON.stringify(x.index))) }, 'Original Native receipt bytes changed'],
    ['different current HEAD', (x: ReturnType<typeof fixture>) => { x.exec.mockResolvedValue({ stdout: 'b'.repeat(40) }) }, 'another current source commit'],
    ['different current Source/build identity', (x: ReturnType<typeof fixture>) => { x.currentIdentity.mockResolvedValue({ ...x.identity, 'apps/desktop/out/main/index.js': 'b'.repeat(64) }) }, 'different current Source or built bytes'],
    ['index byte drift', (x: ReturnType<typeof fixture>) => { x.setChangedIndex(Buffer.concat([x.files.get(resolve(x.repositoryRoot, x.indexPath))!, Buffer.from('\n')])) }, 'index changed during consumption'],
    ['another validated scenario', (x: ReturnType<typeof fixture>) => { x.original.localRecovery.kind = 'navigation'; x.sync() }, 'another scenario']
  ])('rejects %s and never writes a success receipt', async (_label, change, message) => {
    const x = fixture(); change(x)
    await expect(x.methods.consume(x.indexPath)).rejects.toThrow(message)
    expect(x.writeFile).not.toHaveBeenCalled()
    expect(x.process.stdout.write).not.toHaveBeenCalled()
  })

  it.each([
    ['failed original receipt', (x: ReturnType<typeof fixture>) => { x.original.passed = false; x.sync() }, 'actual successful Native receipt'],
    ['cleanup failure', (x: ReturnType<typeof fixture>) => { x.original.cleanup.errors = ['actual cleanup error']; x.sync() }, 'cleanup errors cannot pass'],
    ['forced quit', (x: ReturnType<typeof fixture>) => { x.original.firstExit.signal = 'SIGTERM'; x.sync() }, 'Forced termination'],
    ['missing actual frames', (x: ReturnType<typeof fixture>) => { x.proof.frames = []; x.sync() }, 'actual Native frame artifacts'],
    ['changed original image bytes', (x: ReturnType<typeof fixture>) => { x.files.set(resolve(x.repositoryRoot, 'renderer.png'), Buffer.from('changed image')) }, 'actual image bytes changed']
  ])('uses the actual complete validator to reject %s', async (_label, change, message) => {
    const x = fixture(); change(x)
    await expect(x.methods.consume(x.indexPath)).rejects.toThrow(message)
    expect(x.validator).toHaveBeenCalledTimes(1)
    expect(x.writeFile).not.toHaveBeenCalled()
    expect(x.process.stdout.write).not.toHaveBeenCalled()
  })
})
