// Runs inside the container with the bundled Node and drives the App's own
// RemoteCoreUpgradeManager.check against this installed Core.
// Rosetta emulation shim (test harness only): under Docker Desktop's Rosetta,
// /proc/<pid>/exe is /run/rosetta/rosetta and Node's cmdline gains
// "--no-opt -r /proc/.reset". The shim maps only those two facts back to what a
// native x86_64 kernel reports; every other inspection runs unmodified.
import { realpathSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
const home = process.env.HOME, server = join(home, '.agentmux/server')
const release = realpathSync(join(server, 'state/core-releases/current'))
const { RemoteCoreUpgradeManager, LocalExecutionHost, connectAgentMuxRpc, createPortableCoreArtifact } = await import(join(release, 'dist/index.js'))
const socket = join(server, 'runtime/control.sock')
const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
const { owner } = await client.call('runtime.owner.identity', {})
await client.dispose()
const shim = String.raw`
def _argv(base):
 parts=_raw_cmdline(base)
 if parts[1:4]==['--no-opt','-r','/proc/.reset']: parts=[parts[0]]+parts[4:]
 return parts
def _exe(base): return os.path.realpath(_argv(base)[0])
`
const translate = program => {
  let text = program
  for (const base of ['worker_base', 'base', 'native_base']) {
    text = text.replaceAll(`open(${base}+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))`, `_argv(${base})`)
      .replaceAll(`os.readlink(${base}+'/exe')`, `_exe(${base})`).replaceAll(`sha(${base}+'/exe')`, `sha(_exe(${base}))`)
  }
  // Rosetta also injects UV_USE_IO_URING=0 into Node's initial environment.
  text = text.replace("open(base+'/environ','rb').read().split(bytes([0]))", "[item for item in open(base+'/environ','rb').read().split(bytes([0])) if not item.startswith(b'UV_USE_IO_URING=')]")
  return text.replace('import json,os,sys,hashlib,platform,stat\n', 'import json,os,sys,hashlib,platform,stat\n' +
    "def _raw_cmdline(base): return open(base+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))\n" + shim)
}
// READ_CORE_MAINTENANCE (Node) hashes /proc/<pid>/exe directly; map only that read too.
const translateNode = program => program.replaceAll("fs.readFileSync(base+'/exe')",
  "fs.readFileSync(fs.realpathSync(fs.readFileSync(base+'/cmdline','utf8').split(String.fromCharCode(0))[0]))")
const local = new LocalExecutionHost({ id: 'container' })
const executionHost = () => ({ id: 'container', kind: 'ssh', label: 'container', dispose: async () => {},
  run: (command, args, options) => local.run(command, command === '/usr/bin/python3' && args[0] === '-c' ? ['-c', translate(args[1])]
    : args[0] === '-e' ? ['-e', translateNode(args[1])] : args, options) })
const host = { id: 'container', kind: 'ssh', label: 'container', hostname: 'container.invalid',
  remoteCommand: join(server, 'bin/amux'), remoteSocketPath: socket, runtimeId: owner.runtimeId }
// The candidate is a copy with its own release identity; the installed release stays exactly
// as deployed, because the upgrade check verifies every deployed file.
const { cp, writeFile } = await import('node:fs/promises')
const source = join(await mkdtemp(join(home, 'candidate-source-')), 'core')
await cp(release, source, { recursive: true, verbatimSymlinks: true })
await writeFile(join(source, 'release.json'), JSON.stringify({ sourceCommit: 'container-fixture' }))
const candidate = await createPortableCoreArtifact(await mkdtemp(join(home, 'candidate-')), source).catch(error => ({ error: error.message }))
const manager = new RemoteCoreUpgradeManager({ stateDirectory: join(home, '.client-upgrades'), executionHost,
  artifact: async () => { if (candidate.error) throw new Error(candidate.error); return candidate } })
const check = await manager.check(host)
console.log(JSON.stringify({ current: check.current, eligible: check.eligible, reason: check.reason, detail: check.detail,
  candidate: check.candidate, candidateUnavailable: check.candidateUnavailable }, null, 1))
