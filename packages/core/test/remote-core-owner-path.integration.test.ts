import { afterAll, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { INSPECT_CORE_OWNER, READ_CORE_MAINTENANCE } from '../src/remote-core-upgrade-programs.js'
import { SshExecutionHost } from '../src/execution-host.js'

// Explicit read-only target, never a default production address. Task gates require
// all four cases to execute; the ordinary suite skips this physical Linux probe.
const file = process.env.AGENTMUX_OWNER_INSPECTION_TARGET_FILE
const target = file ? JSON.parse(await readFile(file, 'utf8')) : undefined
const host = target ? new SshExecutionHost(target.ssh) : undefined
const evidence: unknown[] = []
afterAll(async () => {
  await host?.dispose()
  if (process.env.AGENTMUX_OWNER_INSPECTION_REPORT) await writeFile(process.env.AGENTMUX_OWNER_INSPECTION_REPORT, JSON.stringify(evidence, null, 2) + '\n')
})

/** Only the counterexample's worker argv/exe metadata is controlled. The actual
 * complete inspection, deployment/leases, original Node reader, Native and Core
 * read-only calls execute unchanged. No shutdown property or maintenance write. */
function inspectedProgram(mode: string) {
  if (mode === 'actual') return INSPECT_CORE_OWNER
  return `
import builtins,io,json,os,sys
_packet=json.loads(sys.stdin.read());sys.stdin=io.StringIO(json.dumps(_packet))
_open=builtins.open;_readlink=os.readlink
_children=_open('/proc/'+str(_packet['pid'])+'/task/'+str(_packet['pid'])+'/children').read().split()
_worker=None
for _child in _children:
 try:
  _args=_open('/proc/'+_child+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))
  if len(_args)==3 and _args[1].endswith('/dist/control-endpoint-listener-worker.js'):_worker='/proc/'+_child;break
 except FileNotFoundError:pass
if _worker is None:raise RuntimeError('Original controlled read requires its actual listener worker')
def _controlled_open(path,*args,**kwargs):
 if path==_worker+'/cmdline':
  value=_open(path,'rb').read().decode().rstrip(chr(0)).split(chr(0))
  mode=${JSON.stringify(mode)}
  if mode=='alias-dot':value[1]=os.path.dirname(value[1])+'/../dist/control-endpoint-listener-worker.js'
  elif mode=='foreign-program':value[1]='/different-release/dist/control-endpoint-listener-worker.js'
  elif mode=='foreign-node':value[0]='/different-node-image/node'
  return io.BytesIO((chr(0).join(value)+chr(0)).encode())
 return _open(path,*args,**kwargs)
builtins.open=_controlled_open
if ${JSON.stringify(mode)}=='foreign-node':os.readlink=lambda path,*args,**kwargs:'/different-node-image/node' if path==_worker+'/exe' else _readlink(path,*args,**kwargs)
` + INSPECT_CORE_OWNER
}

describe.runIf(Boolean(target))('original Linux Core program identity through aliases', () => {
  it.each(['actual', 'alias-dot'])('the whole Python and Node read qualify one original program while retaining its namespace (%s)', async mode => {
    const physical = await host!.run('/usr/bin/python3', ['-c', inspectedProgram(mode)], { input: JSON.stringify(target.input), timeoutMs: 120000, maxOutputBytes: 1048576 })
    evidence.push({ mode, stage: 'physical', exitCode: physical.exitCode, stderr: physical.stderr })
    expect(physical.exitCode, physical.stderr).toBe(0)
    const launch = JSON.parse(physical.stdout)
    expect(launch).toMatchObject(target.expected)
    expect(launch.stateDirectory).toBe(launch.env.AGENTMUX_STATE_DIRECTORY)
    expect(launch.runtimeDirectory).toBe(launch.env.AGENTMUX_RUNTIME_DIRECTORY)
    expect(launch.storePath).toBe(launch.env.AGENTMUX_AGENT_SESSION_STORE)
    const input = { launch, socket: target.input.socket, runtimeId: target.input.runtimeId }
    expect(Object.hasOwn(input, 'shutdown')).toBe(false)
    const read = await host!.run(launch.node, ['-e', READ_CORE_MAINTENANCE], { input: JSON.stringify(input), timeoutMs: 120000, maxOutputBytes: 1048576 })
    evidence.push({ mode, stage: 'original-producer', exitCode: read.exitCode, stderr: read.stderr })
    expect(read.exitCode, read.stderr).toBe(0)
    const value = JSON.parse(read.stdout)
    expect(value.owner).toMatchObject({ runtimeId: target.input.runtimeId, processId: target.input.pid, ctxmux: { instanceId: target.nativeInstanceId } })
    expect(value.bootstrap.storePath).toBe(launch.storePath)
    expect(value.nativeRuntime.daemonInstanceId).toBe(target.nativeInstanceId)
    expect(value.nativeRuns.map((run: { runId: string }) => run.runId).sort()).toEqual(target.runIds)
    evidence.push({ mode, original: { cli: launch.cli, stateDirectory: launch.stateDirectory, runtimeDirectory: launch.runtimeDirectory, storePath: launch.storePath,
      processId: launch.processId, startTicks: launch.startTicks, nativeProcessId: launch.nativeProcessId, nativeStartTicks: launch.nativeStartTicks,
      nativeInstanceId: value.nativeRuntime.daemonInstanceId, deploymentDigest: launch.deploymentDigest, sourceCommit: launch.sourceCommit, runIds: target.runIds } })
  }, 240000)
  it.each(['foreign-program', 'foreign-node'])('a genuinely different %s remains refused without a maintenance effect', async mode => {
    const result = await host!.run('/usr/bin/python3', ['-c', inspectedProgram(mode)], { input: JSON.stringify(target.input), timeoutMs: 120000, maxOutputBytes: 1048576 })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('The listener worker belongs to another program or Node image.')
    evidence.push({ mode, exitCode: result.exitCode, refused: true })
  }, 120000)
})
