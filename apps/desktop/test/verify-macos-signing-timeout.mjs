import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const realExec = promisify(childProcess.execFile)
const moduleUrl = pathToFileURL(resolve(process.env.AGENTMUX_TEST_SIGNING_MODULE ?? 'apps/desktop/scripts/macos-signing.mjs')).href
const identity = 'A'.repeat(40)
const plan = { kind: 'certificate', profile: 'local', identity }
const app = '/tmp/AgentMux-signing-fixture.app'

test('deep verification waits for its real result; other native calls retain their budgets', async () => {
  const original = childProcess.execFile
  const calls = []
  let rejectVerification = false
  function stub() { throw new Error('The promisified native path was not used.') }
  stub[promisify.custom] = async (command, args, options) => {
    calls.push({ command, args, timeout: options.timeout })
    if (command === '/usr/bin/security') return { stdout: `1) ${identity} "AgentMux Local Fixture"\n`, stderr: '' }
    if (args.includes('--verify')) {
      if (options.timeout > 0) throw new Error('A slow real signature check would be killed by the fixed deadline.')
      if (rejectVerification) throw new Error('Native signature rejection')
      return { stdout: '', stderr: '' }
    }
    if (args.includes('--requirements')) return { stdout: `designated => identifier "dev.agentmux.desktop" and certificate leaf = H"${identity}"`, stderr: '' }
    return { stdout: '', stderr: 'Identifier=dev.agentmux.desktop\nAuthority=AgentMux Local Fixture\nTeamIdentifier=not set\n' }
  }
  childProcess.execFile = stub
  syncBuiltinESMExports()
  try {
    const signing = await import(`${moduleUrl}?default-runner`)
    const verified = await signing.verifyMacosSigning(app, plan)
    assert.equal(verified.identity, identity)
    assert.deepEqual(calls[0].args, ['--verify', '--deep', '--strict', '--verbose=2', '--test-requirement',
      `=identifier "dev.agentmux.desktop" and certificate leaf = H"${identity}" and certificate leaf trusted`, app])
    assert.equal(calls[0].timeout ?? 0, 0)
    assert.equal(calls[1].timeout, 30_000)
    assert.equal(calls[2].timeout, 30_000)
    assert.deepEqual(await signing.preflightMacosSigning({ argv: [], env: {}, loadLocal: async () => plan }), plan)
    assert.equal(calls[3].command, '/usr/bin/security')
    assert.equal(calls[3].timeout, 30_000)
    rejectVerification = true
    const before = calls.length
    await assert.rejects(signing.verifyMacosSigning(app, plan), /Native signature rejection/)
    assert.equal(calls.length, before + 1, 'a native failure must not reach metadata qualification')
  } finally {
    childProcess.execFile = original
    syncBuiltinESMExports()
  }
})

test('actual macOS codesign consumer accepts a signed fixture and rejects it after signature removal', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS codesign is unavailable')
  const dir = await mkdtemp(join(tmpdir(), 'agentmux-signature-timeout-test-'))
  try {
    const binary = join(dir, 'fixture')
    await copyFile('/usr/bin/true', binary)
    await realExec('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'dev.agentmux.desktop', binary])
    const signing = await import(`${moduleUrl}?actual-native`)
    assert.deepEqual(await signing.verifyMacosSigning(binary, { kind: 'ad-hoc' }),
      { kind: 'ad-hoc', authorizationContinuity: 'unverified', notarized: false })
    await realExec('/usr/bin/codesign', ['--remove-signature', binary])
    await assert.rejects(signing.verifyMacosSigning(binary, { kind: 'ad-hoc' }), error =>
      error.code !== 0 && String(error.cmd).startsWith('/usr/bin/codesign --verify '))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an ordinary terminal interrupt stops the in-flight verification and its child', async () => {
  const fixture = `
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const original = childProcess.execFile
    childProcess.execFile = (command, args, options, callback) => {
      const child = original('/bin/sleep', ['30'], options, callback)
      process.stdout.write('ready ' + child.pid + '\\n')
      return child
    }
    syncBuiltinESMExports()
    const signing = await import(process.env.AGENTMUX_TEST_SIGNING_URL)
    await signing.verifyMacosSigning('/tmp/disposable-signing-target', { kind: 'ad-hoc' })
  `
  const parent = childProcess.spawn(process.execPath, ['--input-type=module', '-e', fixture], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGENTMUX_TEST_SIGNING_URL: moduleUrl }
  })
  const exited = once(parent, 'exit')
  let childPid
  try {
    const [chunk] = await Promise.race([
      once(parent.stdout, 'data'),
      exited.then(() => { throw new Error('Verification exited before interruption.') }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Verification fixture did not start.')), 5000).unref())
    ])
    const match = /^ready (\d+)\n$/.exec(String(chunk))
    assert(match, `Unexpected verification fixture output: ${String(chunk)}`)
    childPid = Number(match[1])
    process.kill(-parent.pid, 'SIGINT')
    const [, signal] = await exited
    assert.equal(signal, 'SIGINT')
    for (let i = 0; i < 20; i++) {
      try { process.kill(childPid, 0) } catch (error) {
        if (error.code === 'ESRCH') return
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.fail('The interrupted verification child is still running.')
  } finally {
    if (childPid) {
      const group = await realExec('/bin/ps', ['-o', 'pgid=', '-p', String(childPid)]).catch(() => ({ stdout: '' }))
      if (Number(group.stdout.trim()) === parent.pid) {
        try { process.kill(-parent.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    if (parent.exitCode === null && parent.signalCode === null) {
      try { process.kill(-parent.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await exited
    }
  }
})
