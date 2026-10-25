import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeApplicationProcesses } from '../scripts/package-process-scope.mjs'

describe.skipIf(process.platform !== 'darwin')('installer process identity under slow OS observation', () => {
  it('waits for both fenced process observations and keeps the bound Node owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentmux-slow-process-probe-'))
    const previousPythonPath = process.env.PYTHONPATH
    const executable = realpathSync(process.execPath)
    let child: ChildProcess | undefined
    try {
      // Delay the actual ps subprocess, so the original Python timeout and the
      // outer Node timeout both exercise the production observation path.
      writeFileSync(join(root, 'sitecustomize.py'), `import subprocess\n_original = subprocess.run\ndef _delayed(command, *args, **kwargs):\n    if isinstance(command, list) and command[:2] == ['/bin/ps', '-p']:\n        command = ['/bin/sh', '-c', 'sleep 2.7; exec "$@"', 'slow-ps'] + command\n    return _original(command, *args, **kwargs)\nsubprocess.run = _delayed\n`)
      process.env.PYTHONPATH = previousPythonPath ? `${root}${delimiter}${previousPythonPath}` : root
      child = spawn(executable, ['-e', 'setInterval(() => {}, 1000)'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore'
      })
      await new Promise<void>((resolve, reject) => {
        child!.once('spawn', resolve)
        child!.once('error', reject)
      })
      const pid = child.pid!
      const row = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid=,pid=,ppid=,lstart=,command='], { encoding: 'utf8' })
      const scope = await observeApplicationProcesses({ executable, helperRoot: join(root, 'Frameworks') + '/' }, [], {
        processSnapshot: async () => row
      })
      expect(scope.nodeModes.find(mode => mode.pid === pid)).toMatchObject({
        pid, ppid: process.pid, uid: process.getuid!(), mode: 'node', executable
      })
      // The fixture omits the parent ancestry, so it must remain protected.
      expect(scope.serving).toContain(pid)
      expect(scope.admissions.find(admission => admission.pid === pid)?.classification).toBe('unknown')
    } finally {
      if (previousPythonPath === undefined) delete process.env.PYTHONPATH
      else process.env.PYTHONPATH = previousPythonPath
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise<void>(resolve => child!.once('exit', () => resolve()))
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
