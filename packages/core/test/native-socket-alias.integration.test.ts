import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runProcess } from '../src/process-runner.js'
import { nativeSocketSourceId, type NativeSocketBinding } from '../src/agent-native-socket.js'

// These are exact OS-producer counterexamples, not Native admission receipts.
it.runIf(process.platform === 'darwin').each(['tui-dup', 'peer-dup', 'both-dup', 'distinct', 'inherited-other-pid', 'alias-turnover', 'peer-alias-turnover', 'late-distinct'] as const)('original socket object: %s', async scenario => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-alias-'))), endpoint = join(root, 'socket')
  const binary = join(root, 'carrier'), observer = join(root, 'observer.mjs')
  const compiled = await runProcess('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', fileURLToPath(new URL('./fixtures/native-socket-alias.c', import.meta.url)), '-o', binary])
  expect(compiled.exitCode, compiled.stderr).toBe(0)
  await writeFile(observer, 'console.log(JSON.stringify({observer:true,fd:Number(process.env.AGENTMUX_NATIVE_SOCKET_FD)}))\n')
  const child = spawn(binary, [endpoint, scenario], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const records: Record<string, unknown>[] = []
  let pending = ''
  child.stdout!.on('data', bytes => { pending += String(bytes); for (let end; (end = pending.indexOf('\n')) !== -1;) {
    records.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1)
  } })
  const observed = async (predicate: (record: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 4000
    do { const record = records.find(predicate); if (record) return record; await new Promise(resolve => setTimeout(resolve, 10)) } while (Date.now() < deadline)
    throw new Error('Private socket carrier did not produce its bounded OS fact')
  }
  const helper = fileURLToPath(new URL('../dist/native-socket-peer-darwin', import.meta.url))
  try {
    await observed(record => record.ready === true)
    const opened = await runProcess(helper, [String(child.pid), endpoint, process.execPath, observer], { timeoutMs: 4000 })
    if (scenario === 'distinct' || scenario === 'inherited-other-pid') {
      expect(opened.exitCode).not.toBe(0); expect(JSON.parse(opened.stderr).phase).toBe('ambiguous-original-connection')
      return
    }
    expect(opened.exitCode, opened.stderr).toBe(0)
    const binding = JSON.parse(opened.stdout.split('\n')[0]!) as NativeSocketBinding
    expect(binding).toMatchObject({ runPid: child.pid, peerPid: child.pid })
    const verify = () => runProcess(helper, ['--verify', String(binding.runPid), String(binding.tuiPid), String(binding.peerPid),
      String(binding.tuiFd), String(binding.peerFd), binding.tuiSocket, binding.peerSocket, binding.runBirth, binding.tuiBirth, binding.peerBirth,
      binding.endpoint, `${binding.device}:${binding.inode}`], { timeoutMs: 4000 })
    expect((await verify()).exitCode).toBe(0)
    if (scenario === 'alias-turnover' || scenario === 'peer-alias-turnover') {
      process.kill(scenario === 'alias-turnover' ? binding.tuiPid : binding.peerPid, 'SIGUSR1')
      if (scenario === 'peer-alias-turnover') await runProcess(helper, [String(child.pid), endpoint, process.execPath, observer], { timeoutMs: 4000 })
      const alias = await observed(record => record.role === (scenario === 'alias-turnover' ? 'tui-current-alias' : 'peer-current-alias'))
      expect(alias).toMatchObject({ pid: scenario === 'alias-turnover' ? binding.tuiPid : binding.peerPid,
        so: scenario === 'alias-turnover' ? binding.tuiSocket : binding.peerSocket, conn: scenario === 'alias-turnover' ? binding.peerSocket : binding.tuiSocket })
      expect(alias.fd).not.toBe(scenario === 'alias-turnover' ? binding.tuiFd : binding.peerFd)
      expect((await verify()).exitCode).toBe(0)
      const reopened = await runProcess(helper, [String(child.pid), endpoint, process.execPath, observer], { timeoutMs: 4000 })
      expect(reopened.exitCode, reopened.stderr).toBe(0)
      const current = JSON.parse(reopened.stdout.split('\n')[0]!) as NativeSocketBinding
      expect(nativeSocketSourceId(current)).toBe(nativeSocketSourceId(binding))
      expect(nativeSocketSourceId({ ...current, peerSocket: '1' })).not.toBe(nativeSocketSourceId(binding))
    } else if (scenario === 'late-distinct') {
      process.kill(binding.tuiPid, 'SIGUSR2'); await observed(record => record.role === 'tui-late-distinct')
      const refused = await verify()
      expect(refused.exitCode).not.toBe(0); expect(JSON.parse(refused.stderr).phase).toBe('ambiguous-original-connection')
    }
    expect(child.exitCode).toBeNull()
  } finally {
    process.kill(-child.pid!, 'SIGTERM')
    const deadline = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ } }, 1000)
    try { await new Promise<void>(resolve => child.once('close', () => resolve())) } finally { clearTimeout(deadline); await rm(root, { recursive: true, force: true }) }
  }
}, 10_000)
