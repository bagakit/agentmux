import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { START_CORE, RELEASE_CORE_SERVICE_START } from '../src/remote-core-upgrade-programs.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(mainPID = 0) {
  const root = await mkdtemp(join(tmpdir(), 'core-systemd-')); roots.push(root)
  const bin = join(root, 'bin'), stateDirectory = join(root, 'state'), runtimeDirectory = join(root, 'user-runtime'), releaseDirectory = join(stateDirectory, 'core-releases', 'b'.repeat(64))
  await Promise.all([mkdir(bin), mkdir(releaseDirectory, { recursive: true }), mkdir(runtimeDirectory)])
  const service = { unit: 'owned-core.service', fragmentPath: join(root, 'owned-core.service'), controlGroup: '/user.slice/owned-core.service', runtimeDirectory }
  const facts = join(runtimeDirectory, 'facts.json'), calls = join(runtimeDirectory, 'calls.json')
  await writeFile(facts, JSON.stringify({ Id: service.unit, FragmentPath: service.fragmentPath, ControlGroup: service.controlGroup, MainPID: String(mainPID), KillMode: 'process' }))
  await writeFile(calls, '[]')
  // The real transported START program calls this executable. It models only the
  // user manager, never the Core's start decision or operation-file writer.
  await writeFile(join(bin, 'systemctl'), '#!' + process.execPath + '\n' + `
const fs=require('node:fs'),path=require('node:path'),dir=process.env.XDG_RUNTIME_DIR;
if(process.env.DBUS_SESSION_BUS_ADDRESS!=='unix:path='+dir+'/bus')process.exit(3);
const args=process.argv.slice(2),file=path.join(dir,'facts.json'),calls=path.join(dir,'calls.json');
fs.writeFileSync(calls,JSON.stringify([...JSON.parse(fs.readFileSync(calls)),args]));
const facts=JSON.parse(fs.readFileSync(file));
if(args[1]==='show')console.log(Object.entries(facts).map(([k,v])=>k+'='+v).join('\\n'));
else if(args[1]==='start'){facts.MainPID='303';fs.writeFileSync(file,JSON.stringify(facts));}
else if(args[1]!=='daemon-reload')process.exit(2);
`, { mode: 0o755 })
  const input = { stateDirectory, operationId: 'original', node: process.execPath, cwd: root,
    env: { HOME: root, PATH: bin, AGENTMUX_STATE_DIRECTORY: stateDirectory }, releaseDirectory, service }
  const invoke = (program: string, body: object = input) => spawnSync(process.execPath, ['-e', program], { input: JSON.stringify(body), env: { ...process.env, PATH: bin + ':' + process.env.PATH }, encoding: 'utf8' })
  const dropin = join(runtimeDirectory, 'systemd', 'user', service.unit + '.d', '50-agentmux-original.conf')
  return { root, input, calls, facts, dropin, invoke }
}

it('starts the exact original user unit with an operation-owned runtime override, then releases only that override', async () => {
  const f = await fixture(), started = f.invoke(START_CORE)
  expect(started.status, started.stderr).toBe(0)
  expect(JSON.parse(started.stdout)).toEqual({ processId: 303 })
  const script = join(f.input.stateDirectory, 'core-releases', 'original.service-start.sh')
  expect(await readFile(script, 'utf8')).toContain(f.input.releaseDirectory + '/dist/headless-runtime-cli.js')
  expect(await readFile(f.dropin, 'utf8')).toContain('ExecStart=' + JSON.stringify(script))
  const calls = JSON.parse(await readFile(f.calls, 'utf8')) as string[][]
  expect(calls.some(args => args[1] === 'start' && args[2] === 'owned-core.service')).toBe(true)
  expect(calls.some(args => args.includes('restart') || args.includes('stop'))).toBe(false)
  const other = join(f.dropin, '..', 'other.conf'); await writeFile(other, '[Service]\n# retained\n')
  const released = f.invoke(RELEASE_CORE_SERVICE_START, { ...f.input, processId: 303 })
  expect(released.status, released.stderr).toBe(0)
  await expect(readFile(f.dropin)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(script)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(other, 'utf8')).toContain('retained')
  // Neither starting nor releasing the temporary command chooses a persistent release.
  expect(await readdir(join(f.input.stateDirectory, 'core-releases'))).not.toContain('current')
  expect(f.invoke(START_CORE).stderr).toContain('original start admission already exists')
})

it('refuses a unit whose MainPID already belongs to another process without starting or overriding it', async () => {
  const f = await fixture(999), result = f.invoke(START_CORE)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('another MainPID')
  await expect(readFile(f.dropin)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(await readFile(f.calls, 'utf8')).some((args: string[]) => args[1] === 'start')).toBe(false)
})

it('retains the operation override when cleanup cannot confirm the same new MainPID', async () => {
  const f = await fixture(); expect(f.invoke(START_CORE).status).toBe(0)
  const result = f.invoke(RELEASE_CORE_SERVICE_START, { ...f.input, processId: 404 })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('temporary command was retained')
  expect(await readFile(f.dropin, 'utf8')).toContain('[Service]')
})
