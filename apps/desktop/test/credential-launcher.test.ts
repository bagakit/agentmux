import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, expect, it } from 'vitest'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { backupConnections } from '../../../packages/connectors/src/connection-backup.js'

const cleanup: Array<() => unknown | Promise<unknown>> = [], facts: unknown[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { if (process.env.LAUNCHER_FACTS) await writeFile(process.env.LAUNCHER_FACTS, JSON.stringify({ scope: 'Real Node parent/SQLite/backup/converter and production native worker source over actual default JSON child IPC. Electron app/provider are controlled in child; separate real Electron ready/echo probe does not use keys.', facts }, null, 2) + '\n') })
async function fixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'credential-launcher-')), directory = join(root, 'connections'), evidence = join(root, 'evidence')
  await mkdir(directory, { mode: 0o700 }); await mkdir(evidence, { mode: 0o700 })
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(directory, 'connections.sqlite'), database = new DatabaseSync(path), secrets = new ConnectionSecrets(database)
  await secrets.store({ operationId: 'original-current', secret: 'Synthetic current value' })
  for (const id of ['one', 'two']) database.prepare('INSERT INTO connection_credential VALUES (?,?,?)').run('ref-' + id, 'op-' + id, Buffer.from('v10synthetic-' + id))
  const before = database.prepare('SELECT * FROM connection_credential ORDER BY credential_ref').all(), backup = await backupConnections(database, directory)
  const original = await stat(path); database.close()
  const request = { operationId: 'original-launcher-operation', applicationName: 'AgentMux', evidenceDirectory: evidence, databasePath: path,
    expectedDatabase: { device: String(original.dev), inode: String(original.ino) }, backup: { ...backup, ...(mode === 'bad-backup' ? { sha256: '0'.repeat(64) } : {}) } }
  const requestPath = join(root, 'request.json'), shim = join(root, 'controlled-electron.cjs'), trace = join(root, 'provider.ndjson')
  await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 })
  await writeFile(shim, `const Module=require('node:module'),fs=require('node:fs');const load=Module._load;
const log=stage=>fs.appendFileSync(process.env.LAUNCHER_TRACE,JSON.stringify({stage})+'\\n');
if(['early-close','spawn-failure'].includes(process.env.LAUNCHER_MODE)){
 const cp=require('node:child_process'),fsp=require('node:fs/promises'),spawn=cp.spawn,write=fsp.writeFile;let closed=Promise.resolve();
 cp.spawn=function(...args){const child=spawn.apply(this,args);closed=new Promise(done=>child.once('close',done));return child};
 fsp.writeFile=async function(file,...args){if(String(file).endsWith('/execution-started.json')){await closed;log('start-write-after-child-close')}return write.call(this,file,...args)};
 Module.syncBuiltinESMExports();
}
Module._load=function(name,...args){if(name!=='electron')return load.call(this,name,...args);
 if(process.argv[1].endsWith('migrate-connection-credentials.mjs')){log('native-process');return process.env.LAUNCHER_MODE==='spawn-failure'?'/nonexistent/original-native-child':process.execPath}
 if(process.env.LAUNCHER_MODE==='early-close')process.exit(1);
 return{app:{setName:name=>{if(name!=='AgentMux')throw Error('wrong namespace')},setPath(){},setActivationPolicy(){},whenReady:async()=>{log('ready')},exit:code=>process.exit(code)},
 safeStorage:{isAsyncEncryptionAvailable:async()=>{log('provider');return true},decryptStringAsync:async bytes=>{log('decrypt');if(process.env.LAUNCHER_MODE==='native-failure')throw Error('Synthetic MUST_NOT_APPEAR secret');return{result:'Synthetic native result '+bytes.toString('utf8').slice(-3)}}}}};`, { mode: 0o600 })
  const child = spawn(process.execPath, [resolve('apps/desktop/scripts/migrate-connection-credentials.mjs'), requestPath], {
    env: { ...process.env, NODE_OPTIONS: '--require ' + shim, LAUNCHER_MODE: mode, LAUNCHER_TRACE: trace, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done) })
  const events = await readFile(trace, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => [])
  const reopened = new DatabaseSync(path), after = reopened.prepare('SELECT * FROM connection_credential ORDER BY credential_ref').all()
  const values = []
  if (code === 0) for (const id of ['one', 'two']) values.push(await new ConnectionSecrets(reopened).resolve('ref-' + id))
  reopened.close()
  const execution = JSON.parse(await readFile(join(evidence, 'execution-result.json'), 'utf8'))
  const receipt = await readFile(join(evidence, 'conversion-receipt.json'), 'utf8').then(JSON.parse, () => null)
  return { code, stdout, stderr, events, before, after, values, execution, receipt }
}

it.each(['success', 'bad-backup', 'native-failure', 'spawn-failure', 'early-close'])('the original Node launcher preserves private boundaries for %s', async mode => {
  const f = await fixture(mode)
  const stages = f.events.map(event => event.stage)
  expect(f.stdout + f.stderr).not.toMatch(/Synthetic native result|MUST_NOT_APPEAR|v10synthetic/)
  facts.push({ case: mode, exitCode: f.code, nativeProcesses: stages.filter(stage => stage === 'native-process').length,
    providers: stages.filter(stage => stage === 'provider').length, decrypts: stages.filter(stage => stage === 'decrypt').length,
    originalRowsUnchanged: JSON.stringify(f.before) === JSON.stringify(f.after), result: f.receipt?.result ?? null,
    executionResultPresent: true, noUnhandledRejection: !f.stderr.includes('UnhandledPromiseRejection') })
  if (mode === 'success') {
    expect(f.code, f.stdout + f.stderr).toBe(0)
    expect(stages.filter(stage => stage === 'native-process')).toHaveLength(1)
    expect(stages.filter(stage => stage === 'provider')).toHaveLength(1)
    expect(stages.filter(stage => stage === 'decrypt')).toHaveLength(2)
    expect(f.values).toEqual(['Synthetic native result one', 'Synthetic native result two'])
    expect(f.receipt.result).toEqual({ scanned: 3, alreadyCurrent: 1, converted: 2, verified: 2, backupConfirmed: true, committed: true })
    expect(f.before.map(row => [row.credential_ref, row.operation_id])).toEqual(f.after.map(row => [row.credential_ref, row.operation_id]))
  } else {
    expect(f.code).toBe(1); expect(f.after).toEqual(f.before); expect(f.receipt).toBeNull()
    expect(f.execution.events.at(-1).stage).toBe('conversion-unconfirmed')
    expect(f.stderr).not.toContain('UnhandledPromiseRejection')
    if (mode === 'bad-backup') expect(stages).toHaveLength(0)
    if (mode === 'spawn-failure' || mode === 'early-close') { expect(stages.filter(stage => stage === 'provider')).toHaveLength(0); expect(stages).toContain('start-write-after-child-close') }
  }
})
