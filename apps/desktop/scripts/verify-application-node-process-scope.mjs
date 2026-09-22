import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { observeApplicationProcesses, assertApplicationActivationOwnership } from './package-process-scope.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

assert.equal(process.platform, 'darwin')
const exec = promisify(execFile), base = resolve('.')
const out = join(base, '.tmp/application-node-process-scope-proof-20261003')
const selectedApp = join(base, 'apps/desktop/node_modules/electron/dist/Electron.app')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = async path => sha(await readFile(path))
const inputs = [new URL(import.meta.url).pathname, new URL('./package-process-scope.mjs', import.meta.url).pathname,
  new URL('./package-macos.mjs', import.meta.url).pathname, new URL('./probe-process.mjs', import.meta.url).pathname,
  join(base, 'apps/desktop/test/package-process-scope.test.ts'), join(base, 'apps/desktop/test/package-runtime-upgrade.test.ts'),
  join(selectedApp, 'Contents/MacOS/Electron'),
  join(selectedApp, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')]
const before = Object.fromEntries(await Promise.all(inputs.map(async path => [path, await digest(path)])))
await mkdir(out, { recursive: true })
const root = await mkdtemp('/tmp/amx-app-node-'), app = join(root, 'Selected.app')
const executable = join(app, 'Contents/MacOS/Electron'), bundle = { executable, helperRoot: join(app, 'Contents/Frameworks/') }
const children = [], records = [], cleanupErrors = []
let failure
const wait = async (read, accept, label) => {
  const deadline = Date.now() + 10_000
  do { const value = await read(); if (accept(value)) return value; await new Promise(done => setTimeout(done, 20)) } while (Date.now() < deadline)
  throw new Error(`Private deadline: ${label}`)
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function launch(args, node) {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE
  if (node) env.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(executable, args, { cwd: root, env, detached: true, stdio: ['pipe', 'ignore', 'pipe'] })
  children.push(child); child.stderr.on('data', () => {})
  return child
}
async function command(key, value) {
  const path = join(root, `${key}-command.json`)
  await writeFile(`${path}.next`, JSON.stringify({ value })); await rename(`${path}.next`, path)
  return wait(() => json(join(root, `${key}-io.json`)), result => result?.value === value, `${key} exact IO ${value}`)
}
try {
  await exec('/usr/bin/ditto', [selectedApp, app], { timeout: 30_000 })
  assert.equal(await digest(executable), before[join(selectedApp, 'Contents/MacOS/Electron')])
  const worker = join(root, 'worker.cjs'), main = join(root, 'main.cjs')
  await writeFile(worker, String.raw`
const fs=require('node:fs'),path=require('node:path'),[root,key]=process.argv.slice(2);
const p=s=>path.join(root,key+'-'+s);let last;
function store(path,value){fs.writeFileSync(path+'.next',JSON.stringify(value));fs.renameSync(path+'.next',path);}
store(p('ready.json'),{pid:process.pid,ppid:process.ppid});
const timer=setInterval(()=>{
 if(fs.existsSync(p('release'))){clearInterval(timer);process.exit(0);}
 if(fs.existsSync(p('command.json'))){const {value}=JSON.parse(fs.readFileSync(p('command.json'),'utf8'));
  if(value!==last){last=value;store(p('io.json'),{pid:process.pid,value});}}
},10);
`)
  await writeFile(join(root, 'empty.html'), '<!doctype html><title>Private scope</title><p>Private scope</p>')
  await writeFile(main, String.raw`
const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const [root,key]=process.argv.slice(2).filter(v=>v!=='ELECTRON_RUN_AS_NODE=1');
app.setPath('userData',path.join(root,'user-data'));app.setPath('sessionData',path.join(root,'user-data'));
app.whenReady().then(async()=>{
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_OPTIONS;
 const worker=spawn(process.execPath,[path.join(root,'worker.cjs'),root,'owned-'+key],{cwd:root,env,stdio:'ignore'});
 const window=new BrowserWindow({show:false,width:320,height:240});await window.loadFile(path.join(root,'empty.html'));
 const result=path.join(root,key+'-main.json');fs.writeFileSync(result+'.next',JSON.stringify({pid:process.pid,workerPid:worker.pid,
  userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),storage:session.defaultSession.getStoragePath()}));fs.renameSync(result+'.next',result);
 process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{if(text.trim()==='quit')app.quit();});
});
`)
  const external = launch([worker, root, 'external'], true)
  const externalReady = await wait(() => json(join(root, 'external-ready.json')), value => value?.pid === external.pid, 'external Node ready')
  const initial = await observeApplicationProcesses(bundle)
  assert.deepEqual(initial.serving, []); assert.deepEqual(initial.externalNode, [external.pid])
  assert.equal(initial.nodeModes.find(row => row.pid === external.pid)?.mode, 'node')
  assert.equal(initial.nodeModes.find(row => row.pid === external.pid)?.executable, executable)
  const first = launch([main, root, 'first', 'ELECTRON_RUN_AS_NODE=1'], false)
  const firstMain = await wait(() => json(join(root, 'first-main.json')), value => value?.pid === first.pid, 'first hidden GUI ready')
  assert.equal(firstMain.storage, join(root, 'user-data')); assert.equal(firstMain.userData, firstMain.sessionData)
  await wait(() => json(join(root, 'owned-first-ready.json')), value => value?.pid === firstMain.workerPid, 'Main-owned worker ready')
  const active = await observeApplicationProcesses(bundle)
  assert.ok(active.serving.includes(first.pid)); assert.ok(active.serving.includes(firstMain.workerPid))
  assert.deepEqual(active.externalNode, [external.pid])
  assert.equal(active.nodeModes.find(row => row.pid === first.pid)?.mode, 'gui') // argv environment word is not the selected key.
  assert.equal(active.nodeModes.find(row => row.pid === firstMain.workerPid)?.mode, 'node')
  assert.equal(active.nodeModes.find(row => row.pid === first.pid)?.executable, executable)
  assert.equal(active.nodeModes.find(row => row.pid === firstMain.workerPid)?.executable, executable)
  const owners = assertApplicationActivationOwnership({ previous: [], beforeLaunch: initial.processes,
    current: active.processes, serving: active.serving, mainPid: first.pid })
  assert.ok(owners.length >= 2)
  assert.equal((await command('external', 'before-quit')).pid, external.pid)
  assert.equal((await command('owned-first', 'owned-file-before-quit')).pid, firstMain.workerPid)
  const previous = active.processes.filter(row => active.serving.includes(row.pid))
  first.stdin.write('quit\n')
  await wait(() => first.exitCode, code => code === 0, 'ordinary first GUI quit')
  assert.equal(alive(firstMain.workerPid), true)
  const held = await observeApplicationProcesses(bundle, previous)
  assert.ok(held.serving.includes(firstMain.workerPid)); assert.deepEqual(held.externalNode, [external.pid])
  assert.ok(!held.processes.some(row => row.pid === first.pid))
  assert.throws(() => assertApplicationActivationOwnership({ previous, beforeLaunch: [], current: held.processes,
    serving: held.serving, mainPid: first.pid }), /previous application owner/)
  assert.equal((await command('owned-first', 'owned-file-after-Main-quit')).pid, firstMain.workerPid)
  await writeFile(join(root, 'owned-first-release'), '')
  await wait(() => observeApplicationProcesses(bundle, previous), scope => scope.serving.length === 0, 'old worker really exited')
  const baseline = await observeApplicationProcesses(bundle, previous)
  assert.deepEqual(baseline.serving, []); assert.deepEqual(baseline.externalNode, [external.pid])
  assert.equal((await command('external', 'after-first-quit')).pid, external.pid)
  const second = launch([main, root, 'second'], false)
  const secondMain = await wait(() => json(join(root, 'second-main.json')), value => value?.pid === second.pid, 'ordinary new GUI open')
  const reopened = await observeApplicationProcesses(bundle, previous)
  const newOwners = assertApplicationActivationOwnership({ previous, beforeLaunch: baseline.processes,
    current: reopened.processes, serving: reopened.serving, mainPid: second.pid })
  assert.ok(newOwners.length >= 2); assert.ok(newOwners.some(row => row.pid === secondMain.workerPid))
  assert.deepEqual(reopened.externalNode, [external.pid]); assert.equal(alive(external.pid), true)
  assert.equal((await command('external', 'after-new-GUI')).pid, external.pid)
  assert.equal((await command('owned-second', 'new-owned-file')).pid, secondMain.workerPid)
  records.push({ external: { ...externalReady, identity: initial.processes.find(row => row.pid === external.pid),
    mode: initial.nodeModes.find(row => row.pid === external.pid), exactIO: ['before-quit', 'after-first-quit', 'after-new-GUI'] },
    first: { main: firstMain, owners, nodeModes: active.nodeModes, nodeWorkerProtectedAfterQuit: held.serving,
      exactIO: ['owned-file-before-quit', 'owned-file-after-Main-quit'] },
    second: { main: secondMain, owners: newOwners, nodeModes: reopened.nodeModes, exactIO: 'new-owned-file' } })
  await writeFile(join(root, 'owned-second-release'), '')
  await wait(() => alive(secondMain.workerPid), value => !value, 'new owned worker finished')
  second.stdin.write('quit\n'); await wait(() => second.exitCode, code => code === 0, 'ordinary second GUI quit')
  assert.equal(alive(external.pid), true)
  await writeFile(join(root, 'external-release'), '')
  await wait(() => external.exitCode, code => code === 0, 'external client finished')
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const child of children) {
    try { await stopProbeProcesses(child.pid, root); child.stderr.destroy(); child.stdin.destroy() }
    catch (error) { cleanupErrors.push(error.message) }
  }
  const remaining = [...new Set((await Promise.all(children.map(child => listProbeProcesses(child.pid, root)))).flat())]
  if (remaining.length) cleanupErrors.push(`Private processes remain: ${remaining.join(',')}`)
  const after = Object.fromEntries(await Promise.all(inputs.map(async path => [path, await digest(path)])))
  try { assert.deepEqual(after, before) } catch (error) { failure ??= { name: error.name, message: error.message } }
  if (!cleanupErrors.length) await rm(root, { recursive: true })
  const rootRemoved = await readFile(join(root, 'main.cjs')).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error })
  const receipt = { passed: !failure && cleanupErrors.length === 0 && rootRemoved, root, records, failure,
    inputsBefore: before, inputsAfter: after, cleanup: { errors: cleanupErrors, remaining, rootRemoved } }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, records: records.length, cleanup: receipt.cleanup,
    receipt: join(out, 'receipt.json'), failure: failure?.message ?? null }))
  if (!receipt.passed) process.exitCode = 1
}
