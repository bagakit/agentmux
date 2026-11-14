/* Narrow real-process qualification of the original native File write protocol. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const revision = bytes => 'sha256:' + hash(bytes)
export async function verifyWorkspaceFileTransactions({ helper, syncFaultHelper, report, selected } = {}) {
  helper = resolve(helper)
  const scope = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-file-transactions-')))
  const calls = [], cases = [], children = new Set()
  const receipt = { schema: 'agentmux.file-transactions.v1', passed: false, platform: process.platform, arch: process.arch,
    helper: { path: helper, sha256: hash(await readFile(helper)) }, cases, calls, cleanup: {} }
  function start(parent, name, { expected = revision('old'), content = 'new', exclusive = false, fault = '', createMode, sendInput = true, executable = helper, action = 'write' } = {}) {
    const args = ['--workspace-file', action, parent, name, expected ?? 'null', exclusive ? '1' : '0', '1', fault, '0', '0', '0', 'null',
      ...(createMode === undefined ? [] : [String(createMode)])]
    const child = spawn(executable, args, { cwd: parent, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = '', stderr = '', paused = false, settled = false, inputSent = false, releaseReady, releasePause
    const ready = new Promise(accept => { releaseReady = accept }), pause = new Promise(accept => { releasePause = accept })
    const input = () => { if (!inputSent) { inputSent = true; child.stdin.end(content) } }
    child.stdin.on('error', () => {})
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => {
      stderr += chunk
      if (stderr.split('\n').includes('AGENTMUX_WORKSPACE_READY')) { releaseReady(); if (sendInput) input() }
    })
    child.stdio[3].on('data', () => { paused = true; releasePause() })
    child.stdio[4].on('error', () => {})
    const done = new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        settled = true; children.delete(child)
        const errorLine = stderr.split('\n').find(line => line.startsWith('AGENTMUX_WORKSPACE_ERROR:'))
        const result = { pid: child.pid, args, inputSent, code, signal, stdout, stderr,
          ...(code === 0 ? { result: JSON.parse(stdout) } : errorLine ? { error: JSON.parse(errorLine.slice('AGENTMUX_WORKSPACE_ERROR:'.length)) } : {}) }
        calls.push(result); accept(result)
      })
    })
    const release = () => { if (!child.stdio[4].writableEnded) child.stdio[4].end('R') }
    return { child, ready, pause, done, release, input, get paused() { return paused }, get settled() { return settled } }
  }
  const complete = async promise => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Native transaction probe did not complete')), 10000) })]) }
    finally { clearTimeout(timer) }
  }
  async function run(name, action) {
    if (selected && selected !== name) return
    const parent = join(scope, name); await mkdir(parent)
    const info = await lstat(parent, { bigint: true }), evidence = { parent: { device: String(info.dev), inode: String(info.ino) } }
    try { await action(parent, evidence); cases.push({ name, passed: true, evidence }) }
    catch (error) { cases.push({ name, passed: false, evidence, error: { name: error.name, message: error.message, stack: error.stack } }); throw error }
  }
  async function compete(parent, evidence, absent) {
    if (!absent) await writeFile(join(parent, 'state'), 'old')
    const options = { expected: absent ? null : revision('old'), exclusive: absent, fault: 'before-publish-barrier' }
    const first = start(parent, 'state', { ...options, content: 'first' })
    let second
    try {
      await complete(first.pause)
      second = start(parent, 'state', { ...options, content: 'second' }); await complete(second.ready)
      await delay(150)
      evidence.waiter = { pid: second.child.pid, inputSent: true, pausedWhileFirstHeld: second.paused, settledWhileFirstHeld: second.settled }
      first.release(); const a = await complete(first.done)
      await complete(Promise.race([second.pause, second.done])); if (second.paused) second.release()
      const b = await complete(second.done)
      evidence.results = [a, b]; evidence.finalBytes = await readFile(join(parent, 'state'), 'utf8')
      assert.equal([a, b].filter(item => item.result?.status === 'written').length, 1, 'one writer must publish the observed revision')
      assert.equal([a, b].filter(item => item.result?.status === 'conflict').length, 1, 'the stale writer must receive a real revision conflict')
      assert.equal(evidence.waiter.pausedWhileFirstHeld, false, 'the second process must wait before comparison')
      assert.equal(evidence.finalBytes, 'first')
      assert.equal(a.result.revision, revision(evidence.finalBytes))
    } finally { first.release(); second?.release() }
  }
  try {
    await run('same-revision-two-processes', (parent, evidence) => compete(parent, evidence, false))
    await run('absent-two-processes', (parent, evidence) => compete(parent, evidence, true))
    await run('parent-scope-and-independent-files', async (parent, evidence) => {
      const other = join(parent, 'other'); await mkdir(other)
      await Promise.all(['a', 'b'].map(name => writeFile(join(parent, name), 'old'))); await writeFile(join(other, 'c'), 'old')
      const first = start(parent, 'a', { content: 'a', fault: 'before-publish-barrier' })
      let second
      try {
        await complete(first.pause); second = start(parent, 'b', { content: 'b' }); await complete(second.ready); await delay(150)
        assert.equal(second.settled, false, 'same-parent writes must wait for the short transaction')
        const independent = await complete(start(other, 'c', { content: 'c' }).done)
        assert.equal(independent.result?.status, 'written', 'another parent must not wait for this lock')
        first.release(); const results = await complete(Promise.all([first.done, second.done]))
        assert.deepEqual(results.map(item => item.result?.status), ['written', 'written'])
        evidence.results = [...results, independent]; evidence.otherParent = String((await lstat(other, { bigint: true })).ino)
      } finally { first.release(); second?.release() }
    })
    await run('exit-releases-lock', async (parent, evidence) => {
      await writeFile(join(parent, 'state'), 'old')
      const first = start(parent, 'state', { content: 'never-published', fault: 'before-publish-barrier' })
      try {
        await complete(first.pause); const second = start(parent, 'state', { content: 'survivor' }); await complete(second.ready); await delay(150)
        assert.equal(second.settled, false); assert.equal(await readFile(join(parent, 'state'), 'utf8'), 'old')
        first.child.kill('SIGTERM'); const results = await complete(Promise.all([first.done, second.done]))
        assert.equal(results[0].signal, 'SIGTERM'); assert.equal(results[1].result?.status, 'written')
        assert.equal(await readFile(join(parent, 'state'), 'utf8'), 'survivor'); evidence.results = results
      } finally { if (!first.settled) first.child.kill('SIGTERM') }
    })
    await run('stdin-wait-does-not-lock', async (parent, evidence) => {
      await Promise.all(['a', 'b'].map(name => writeFile(join(parent, name), 'old')))
      const first = start(parent, 'a', { content: 'a', sendInput: false })
      try {
        await complete(first.ready); const second = await complete(start(parent, 'b', { content: 'b' }).done)
        assert.equal(second.result?.status, 'written'); first.input(); const a = await complete(first.done)
        assert.equal(a.result?.status, 'written'); evidence.results = [a, second]
      } finally { first.input() }
    })
    await run('permissions-and-old-protocol', async (parent, evidence) => {
      const standard = await complete(start(parent, 'default', { expected: null, exclusive: true }).done)
      const privateFile = await complete(start(parent, 'private', { expected: null, exclusive: true, createMode: 0o600 }).done)
      assert.equal(standard.result?.status, 'written'); assert.equal(privateFile.result?.status, 'written')
      assert.equal((await lstat(join(parent, 'default'))).mode & 0o777, 0o666 & ~process.umask())
      assert.equal((await lstat(join(parent, 'private'))).mode & 0o777, 0o600 & ~process.umask())
      await chmod(join(parent, 'private'), 0o640)
      const replaced = await complete(start(parent, 'private', { expected: revision('new'), content: 'replacement', createMode: 0o600 }).done)
      assert.equal(replaced.result?.status, 'written'); assert.equal((await lstat(join(parent, 'private'))).mode & 0o777, 0o640)
      for (const createMode of [-1, 0o1000, 1.5, 'NaN', '+384', '384junk', '']) {
        const invalid = await complete(start(parent, 'invalid', { expected: null, createMode }).done)
        assert.equal(invalid.error?.code, 'WORKSPACE_FILE_INVALID_REQUEST'); assert.doesNotMatch(invalid.stderr, /AGENTMUX_WORKSPACE_READY/)
      }
      const wrongAction = await complete(start(parent, 'default', { action: 'read', createMode: 0o600 }).done)
      assert.equal(wrongAction.error?.code, 'WORKSPACE_FILE_INVALID_REQUEST')
      evidence.results = [standard, privateFile, replaced]
    })
    await run('prepublish-failure-and-receipt-unknown', async (parent, evidence) => {
      evidence.results = []
      for (const fault of ['temporary-write', 'replace', 'receipt']) {
        await writeFile(join(parent, 'state'), 'old')
        const result = await complete(start(parent, 'state', { fault }).done); evidence.results.push(result)
        assert.notEqual(result.code, 0); assert.equal(result.error?.writeOutcomeUnknown, fault === 'receipt')
        assert.equal(await readFile(join(parent, 'state'), 'utf8'), fault === 'receipt' ? 'new' : 'old')
      }
    })
    await run('published-readback-refuses-changed-object', async (parent, evidence) => {
      evidence.results = []
      for (const exclusive of [false, true]) {
        const name = exclusive ? 'created' : 'replaced'; if (!exclusive) await writeFile(join(parent, name), 'old')
        const writer = start(parent, name, { expected: exclusive ? null : revision('old'), exclusive, fault: 'after-publish-barrier' })
        try {
          await complete(writer.pause)
          if (exclusive) { await writeFile(join(parent, 'foreign'), 'foreign'); await rename(join(parent, 'foreign'), join(parent, name)) }
          else await writeFile(join(parent, name), 'foreign')
          writer.release(); const result = await complete(writer.done); evidence.results.push(result)
          assert.equal(result.error?.code, 'WORKSPACE_FILE_PUBLISHED_CHANGED'); assert.equal(result.error?.writeOutcomeUnknown, true)
          assert.equal(await readFile(join(parent, name), 'utf8'), 'foreign')
        } finally { writer.release() }
      }
    })
    await run('directory-sync-failure-is-unknown', async (parent, evidence) => {
      assert.ok(syncFaultHelper, 'A private fsync fault build must be supplied; no skipped sync proof')
      evidence.results = []
      for (const exclusive of [false, true]) {
        const name = exclusive ? 'created' : 'replaced'; if (!exclusive) await writeFile(join(parent, name), 'old')
        const result = await complete(start(parent, name, { expected: exclusive ? null : revision('old'), exclusive, executable: resolve(syncFaultHelper) }).done)
        evidence.results.push(result); assert.equal(result.error?.code, 'EIO'); assert.equal(result.error?.writeOutcomeUnknown, true)
        assert.equal(await readFile(join(parent, name), 'utf8'), 'new')
      }
    })
    assert.ok(cases.length > 0, 'The selected native write cases cannot be empty')
    receipt.passed = true
  } catch (error) { receipt.error = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    for (const child of children) child.kill('SIGTERM')
    if (children.size) await delay(50)
    receipt.cleanup.workersExited = children.size === 0
    await rm(scope, { recursive: true, force: true }); receipt.cleanup.privateWorkspaceRemoved = true
    if (report) await writeFile(report, JSON.stringify(receipt, null, 2) + '\n')
  }
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); return [value.slice(2, at), value.slice(at + 1)] }))
  const receipt = await verifyWorkspaceFileTransactions({ helper: options.helper, syncFaultHelper: options['sync-fault-helper'], report: options.report, selected: options.case })
  console.log(JSON.stringify({ passed: receipt.passed, cases: receipt.cases.map(item => ({ name: item.name, passed: item.passed })), cleanup: receipt.cleanup, error: receipt.error }))
  process.exitCode = receipt.passed ? 0 : 1
}
