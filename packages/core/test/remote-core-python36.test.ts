import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteCoreInstallManager } from '../src/remote-core-install.js'
import { PROBE_CORE_INSTALL } from '../src/remote-core-install-programs.js'
import { INSPECT_CORE_OWNER } from '../src/remote-core-upgrade-programs.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

// The local interpreter may be newer. Bind the Python 3.6 POSIX Popen API before
// executing the original producer, then let the real stdlib spawn/collect bytes.
// In 3.6 run forwards unknown keywords to Popen: capture_output and text are not
// accepted there. This is an API compatibility fixture, not a claimed 3.6 VM.
const python36 = String.raw`
import inspect,subprocess
real_run=subprocess.run
def popen36(args,bufsize=-1,executable=None,stdin=None,stdout=None,stderr=None,preexec_fn=None,close_fds=True,shell=False,cwd=None,env=None,universal_newlines=False,startupinfo=None,creationflags=0,restore_signals=True,start_new_session=False,pass_fds=(),encoding=None,errors=None): pass
signature36=inspect.signature(popen36)
def run36(*args,input=None,timeout=None,check=False,**kwargs):
 signature36.bind(*args,**kwargs)
 return real_run(*args,input=input,timeout=timeout,check=check,**kwargs)
subprocess.run=run36
`

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'core-python36-')); roots.push(home)
  const bin = join(home, 'bin'), calls = join(home, 'calls.jsonl'), prefix = join(home, 'server\n原目录')
  await mkdir(bin)
  const facts = { Id: 'original.service', MainPID: '42', FragmentPath: join(home, 'original.service'),
    ControlGroup: '/user.slice/user@' + process.getuid!() + '.service/original.service', KillMode: 'process', ActiveState: 'active' }
  const factsPath = join(home, 'facts.json'); await writeFile(factsPath, JSON.stringify(facts))
  // Private executables model only the external user manager. All decisions and
  // stdout parsing remain in the original transported Python programs.
  const script = '#!' + process.execPath + '\n' + `
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({command:process.argv[1].split('/').pop(),args:process.argv.slice(2),runtime:process.env.XDG_RUNTIME_DIR,bus:process.env.DBUS_SESSION_BUS_ADDRESS})+'\\n');
const args=process.argv.slice(2);
if(args.includes('show-environment')) process.stdout.write('MANAGER=ready\\n');
else if(args.includes('--property=LoadState')) process.stdout.write('not-found\\n');
else if(args.includes('--property=Linger')) process.stdout.write('Linger=yes\\n');
else process.stdout.write(Object.entries(JSON.parse(fs.readFileSync(${JSON.stringify(factsPath)},'utf8'))).map(([k,v])=>k+'='+v).join('\\n')+'\\n');
process.stderr.write('separate manager diagnostic\\n');
`
  await Promise.all(['systemctl', 'loginctl'].map(name => writeFile(join(bin, name), script, { mode: 0o755 })))
  const invoke = (program: string, input: unknown, path = bin) => spawnSync('/usr/bin/python3', ['-c', python36 + '\n' + program],
    { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: home, PATH: path } })
  return { home, bin, prefix, facts, factsPath, invoke, calls: async () => (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}

it('executes the complete install probe with Python 3.6 subprocess arguments and real child output', async () => {
  const f = await fixture(), result = f.invoke(PROBE_CORE_INSTALL, { prefix: f.prefix })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ home: f.home, prefix: f.prefix, installed: false, socket: 'absent',
    systemd: { user: true, linger: true, unitAvailable: true } })
  expect(result.stderr).toBe('')
  expect((await f.calls()).map(call => [call.command, call.args])).toEqual([
    ['systemctl', ['--user', 'show-environment']],
    ['systemctl', ['--user', 'show', 'agentmux-core.service', '--property=LoadState', '--value']],
    ['loginctl', ['show-user', process.env.USER || String(process.getuid!()), '--property=Linger']]
  ])
  expect(await readdir(f.home)).not.toContain('.agentmux')
  await expect(readdir(f.prefix)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps readable install facts when the systemd executable is absent', async () => {
  const f = await fixture(), result = f.invoke(PROBE_CORE_INSTALL, { prefix: f.prefix }, join(f.home, 'missing-bin'))
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ installed: false, socket: 'absent', systemd: { user: false, linger: null, unitAvailable: true } })
})

it('lets the original install owner report glibc 2.28 unsupported instead of a Python keyword failure', async () => {
  const f = await fixture(), artifact = vi.fn(async (): Promise<never> => { throw new Error('must not fetch a candidate') })
  const commands: string[] = []
  const owner = new RemoteCoreInstallManager({ stateDirectory: join(f.home, 'owner'), artifact,
    executionHost: () => ({ id: 'private-probe', label: 'Private probe', kind: 'ssh', dispose: async () => {},
      run: async (command, args, options) => {
        commands.push(command); expect(command).toBe('/usr/bin/python3'); expect(args).toEqual(['-c', PROBE_CORE_INSTALL])
        // Only machine facts are modelled; execute the exact production probe.
        const result = f.invoke("import platform,sys\nsys.platform='linux'\nplatform.machine=lambda:'x86_64'\nplatform.libc_ver=lambda:('glibc','2.28')\n" + args[1], JSON.parse(String(options?.input)))
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 }
      } }) })
  const check = await owner.check({ kind: 'ssh', id: 'private-probe', label: 'Private probe', hostname: 'unused.invalid' }, f.prefix)
  expect(check).toMatchObject({ eligible: false, reason: 'unsupported', probe: { glibc: '2.28', systemd: { user: true, linger: true } } })
  expect(check.detail).toBe('This Host has glibc 2.28; the bundled runtime needs 2.34 or newer.')
  expect(commands).toEqual(['/usr/bin/python3']); expect(artifact).not.toHaveBeenCalled()
  await expect(readdir(f.prefix)).rejects.toMatchObject({ code: 'ENOENT' })
})

// Full /proc owner qualification requires Linux. On every platform execute its
// original AST-selected service inspection branch (not a reimplemented parser).
const upgradeServiceBranch = String.raw`
import ast,json,os
p=json.loads(__import__('sys').stdin.read())
tree=ast.parse(p['program'])
loops=[s for s in tree.body if isinstance(s,ast.For) and isinstance(s.target,ast.Name) and s.target.id=='row']
assert len(loops)==1
pid=42; base='/private-original-owner'; service=None
uid=os.getuid(); user_runtime='/run/user/'+str(uid)
def text(path):
 assert path==base+'/cgroup'
 return '0::'+p['group']
exec(compile(ast.Module(body=loops,type_ignores=[]),'<original-owner-service>','exec'))
print(json.dumps(service))
`

it('executes the original upgrade service observation with the same legacy subprocess API', async () => {
  const f = await fixture(), result = f.invoke(upgradeServiceBranch, { program: INSPECT_CORE_OWNER, group: f.facts.ControlGroup })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ unit: f.facts.Id, fragmentPath: f.facts.FragmentPath, controlGroup: f.facts.ControlGroup,
    runtimeDirectory: '/run/user/' + process.getuid!() })
  const calls = await f.calls()
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual({ command: 'systemctl', args: ['--user', 'show', f.facts.Id, '--property=Id,MainPID,FragmentPath,ControlGroup,KillMode,ActiveState'],
    runtime: '/run/user/' + process.getuid!(), bus: 'unix:path=/run/user/' + process.getuid!() + '/bus' })
})

it.each([{ MainPID: '99' }, { KillMode: 'control-group' }])('still refuses unqualified service facts %j without any mutation command', async changed => {
  const f = await fixture(); await writeFile(f.factsPath, JSON.stringify({ ...f.facts, ...changed }))
  const result = f.invoke(upgradeServiceBranch, { program: INSPECT_CORE_OWNER, group: f.facts.ControlGroup })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('no owner was stopped')
  expect((await f.calls()).map(call => call.args[1])).toEqual(['show'])
})
