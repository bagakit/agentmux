import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { activate } from './desktop.mjs'

const port = 'globalThis.__settingsCrashLogProof'
const pane = '[data-settings-pane="general"]:not([hidden])'

/** Real fixed-path stat and registered IPC/Control. Only the native shell request and exact
 * owned-path EIO are controlled ports; no file manager is opened and no product bundle is edited. */
export function crashLogDiagnosticsProof({ probe, desktopRoot, userData, command, configPath, section, waitFor, phase }) {
  const path = join(userData, 'crash-log.ndjson'), body = 'PRIVATE_GENERAL_LOG_BODY_NOT_FOR_CLI\n'
  const facts = { path, shellRequestControlled: true, exactOwnedEioControlled: true, cases: [] }
  const probes = new Set()
  const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron')`
  let originalConfig
  const get = () => command(['diagnostics', 'crash-log'])
  const reveal = code => command(['diagnostics', 'crash-log', 'reveal'], code)
  const shellCalls = target => target.main.evaluate(`${port}.requests`)
  const status = target => target.cdp.evaluate(`document.querySelector(${JSON.stringify(`${pane} .settings-crash-log-status`)})?.textContent ?? null`)
  async function install(target) {
    await target.main.evaluate(`(() => {
      const shell=${electron}.shell, fs=process.getBuiltinModule('fs/promises'), module=process.getBuiltinModule('module');
      const fixed=${JSON.stringify(path)}, originalShell=shell.showItemInFolder, originalStat=fs.stat;
      if(typeof originalShell!=='function'||typeof originalStat!=='function')throw Error('Owned native boundaries must be nonempty');
      const facts=${port}={requests:[],eio:false,shellFailure:false};
      shell.showItemInFolder=function(value){facts.requests.push(value);if(facts.shellFailure)throw Object.assign(Error('Controlled owned shell EIO'),{code:'EIO'})};
      fs.stat=function(...args){if(args[0]===fixed&&facts.eio)return Promise.reject(Object.assign(Error('Controlled owned diagnostic EIO'),{code:'EIO'}));return originalStat.apply(this,args)};
      module.syncBuiltinESMExports();
      facts.restore=()=>{shell.showItemInFolder=originalShell;fs.stat=originalStat;module.syncBuiltinESMExports();facts.restored=true};
      return true;
    })()`)
    probes.add(target)
  }
  async function ui(target, expected, text) {
    const before = (await shellCalls(target)).length
    await activate(target.cdp, `Array.from(document.querySelectorAll(${JSON.stringify(`${pane} .settings-diagnostics button`)})).filter(node=>node.textContent.trim()==='Show crash log')`)
    await waitFor('General current typed receipt', async () => (await status(target))?.includes(text))
    const actual = await status(target)
    assert.ok(actual.includes(path)); assert.ok(!actual.includes(body.trim()))
    assert.equal((await shellCalls(target)).length, before + (expected === 'requested' ? 1 : 0))
    assert.ok(await target.cdp.evaluate(`document.querySelector(${JSON.stringify(pane)}).textContent.includes('never uploaded')`))
    assert.ok(!actual.includes('Opened in'))
    return actual
  }
  async function fact(outcome, code) {
    const result = await get()
    assert.equal(result.operation, 'diagnostics.crash-log.get')
    assert.equal(result.result.path, path); assert.equal(result.result.outcome, outcome)
    if (code) assert.equal(result.result.cause.code, code)
    assert.ok(!JSON.stringify(result).includes(body.trim()))
    return result.result
  }
  async function configUnchanged() { assert.deepEqual(await readFile(configPath), originalConfig) }
  return {
    facts,
    async exercise() {
      phase('general-diagnostics')
      originalConfig = await readFile(configPath)
      const publications = await probe.cdp.evaluate('window.__settingsCliProof.configEvents.length')
      await section(probe, 'General', 'general'); await install(probe)
      try {
        await rm(path, { force: true })
        const absent = await fact('absent')
        const missing = await reveal(1); assert.equal(missing.error.code, 'CONTROL_FAILED'); assert.ok(missing.error.message.includes('ENOENT'))
        const absentUi = await ui(probe, 'absent', 'No crash log file exists at this path.')
        assert.deepEqual(await shellCalls(probe), [])
        facts.cases.push({ absent, reveal: missing.error, ui: absentUi })

        await mkdir(path)
        const directory = await fact('check-failed', 'CRASH_LOG_NOT_FILE')
        const nonregular = await reveal(1); assert.equal(nonregular.error.code, 'CRASH_LOG_NOT_FILE')
        await ui(probe, 'check-failed', 'CRASH_LOG_NOT_FILE')
        assert.deepEqual(await shellCalls(probe), [])
        facts.cases.push({ directory, reveal: nonregular.error })
        await rm(path, { recursive: true })
        await writeFile(path, body, { mode: 0o600 })

        await chmod(userData, 0o000)
        try {
          const actualFs = await probe.main.evaluate(`process.getBuiltinModule('fs/promises').stat(${JSON.stringify(path)}).then(()=>({unexpected:true}),error=>({code:error.code,message:error.message}))`)
          assert.equal(actualFs.code, 'EACCES')
          const denied = await fact('check-failed', 'EACCES')
          assert.equal(denied.cause.message, actualFs.message)
          const deniedReveal = await reveal(1); assert.equal(deniedReveal.error.code, 'CONTROL_FAILED'); assert.ok(deniedReveal.error.message.includes('EACCES'))
          await ui(probe, 'check-failed', 'EACCES')
          assert.deepEqual(await shellCalls(probe), [])
          facts.cases.push({ actualOwnedFilesystem: actualFs, denied, reveal: deniedReveal.error })
        } finally { await chmod(userData, 0o700) }

        await probe.main.evaluate(`${port}.eio=true`)
        try {
          const io = await fact('check-failed', 'EIO')
          assert.equal(io.cause.message, 'Controlled owned diagnostic EIO')
          const ioReveal = await reveal(1); assert.equal(ioReveal.error.code, 'CONTROL_FAILED'); assert.ok(ioReveal.error.message.includes('EIO'))
          await ui(probe, 'check-failed', 'EIO')
          assert.deepEqual(await shellCalls(probe), [])
          facts.cases.push({ controlledOwnedEio: io, reveal: ioReveal.error })
        } finally { await probe.main.evaluate(`${port}.eio=false`) }

        const present = await fact('present')
        assert.deepEqual(await shellCalls(probe), [], 'Read-only present never requests the shell')
        const requested = await reveal(0)
        assert.deepEqual(requested.result, { path, requested: true })
        assert.deepEqual(await shellCalls(probe), [path])
        const requestedUi = await ui(probe, 'requested', 'Requested in your file manager.')
        assert.deepEqual(await shellCalls(probe), [path, path])
        await probe.main.evaluate(`${port}.shellFailure=true`)
        try {
          const failed = await reveal(1); assert.equal(failed.error.code, 'CONTROL_FAILED'); assert.ok(failed.error.message.includes('EIO · Controlled owned shell EIO'))
          facts.cases.push({ controlledShellFailure: failed.error })
        } finally { await probe.main.evaluate(`${port}.shellFailure=false`) }
        assert.deepEqual(await shellCalls(probe), [path, path, path])
        facts.cases.push({ present, requested: requested.result, ui: requestedUi, requests: await shellCalls(probe) })
        await configUnchanged(); assert.equal(await readFile(path, 'utf8'), body)
        assert.equal(await probe.cdp.evaluate('window.__settingsCliProof.configEvents.length'), publications)
        facts.configurationUnchanged = true; facts.publicationsUnchanged = true; facts.noBodyOutput = true
      } finally {
        await chmod(userData, 0o700)
        await probe.main.evaluate(`${port}.restore()`)
      }
    },
    async verifyRestart(target) {
      await section(target, 'General', 'general')
      assert.equal(await status(target), null, 'A new Desktop does not claim an old file-manager request')
      assert.ok(await target.cdp.evaluate(`document.querySelector(${JSON.stringify(pane)}).textContent.includes('never uploaded')`))
      await install(target)
      facts.restart = await fact('present')
      assert.deepEqual(await shellCalls(target), [])
      assert.equal(await readFile(path, 'utf8'), body)
      await configUnchanged()
    },
    async verifyNoView(target) {
      facts.noView = { fact: await fact('present'), request: (await reveal(0)).result }
      assert.deepEqual(facts.noView.request, { path, requested: true })
      assert.deepEqual(await shellCalls(target), [path])
      await target.main.evaluate(`${port}.restore()`)
    },
    async verifyOffline() {
      const before = await readFile(path)
      for (const args of [['diagnostics', 'crash-log'], ['diagnostics', 'crash-log', 'reveal']]) {
        const result = await command(args, 1); assert.equal(result.error.code, 'CONTROL_UNAVAILABLE')
      }
      assert.deepEqual(await readFile(path), before)
      facts.offline = { code: 'CONTROL_UNAVAILABLE', originalLogUnchanged: true }
    },
    async cleanup() {
      await chmod(userData, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error })
      for (const target of probes) {
        if (target.child.exitCode === null && target.child.signalCode === null) await target.main.evaluate(`${port}?.restore()`).catch(() => {})
      }
    }
  }
}
