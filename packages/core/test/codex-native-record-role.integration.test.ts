import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { nativeProcessFiles } from '../src/agent-native-process.js'
import { locateAppServerNativeSession } from '../src/providers/app-server-native-session.js'
import { codexMainNativeRecord } from '../src/providers/codex-native-record-role.js'

it.each([
  { name: 'legacy CLI', payloads: [{ source: 'cli' }], main: true },
  { name: 'CLI user role', payloads: [{ source: 'cli', thread_source: 'user' }], main: true },
  { name: 'remote TUI user role', payloads: [{ source: 'vscode', thread_source: 'user' }], main: true },
  { name: 'display name without role', payloads: [{ source: 'vscode', originator: 'codex-tui' }], main: false },
  { name: 'unknown role with CLI origin', payloads: [{ source: 'cli', thread_source: 'future' }], main: false },
  { name: 'unknown origin', payloads: [{ source: 'future', thread_source: 'user' }], main: false },
  { name: 'child conflicts with user role', payloads: [{ source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }, thread_source: 'user' }], main: false },
  { name: 'multiple user roots', payloads: [{ source: 'vscode', thread_source: 'user' }, { source: 'vscode', thread_source: 'user' }], main: false },
  { name: 'read-only borrowed record', payloads: [{ source: 'vscode', thread_source: 'user' }], main: false, readOnly: true },
])('Codex machine role discovers $name only on the original live writer', async ({ payloads, main, readOnly }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-role-')))
  const files = await Promise.all(payloads.map(async (payload, index) => {
    const path = join(root, `rollout-owned-${index}.jsonl`)
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: `thread-${index}`, ...payload } }) + '\n')
    return path
  }))
  const child = spawn(process.execPath, ['-e', `const fs=require('fs');for(const p of process.argv.slice(1))fs.openSync(p,${JSON.stringify(readOnly ? 'r' : 'r+')});console.log('ready');setInterval(()=>{},1000);`, ...files],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(child.stdout!, 'data')
    const context = { processId: child.pid!, command: process.execPath, args: [], workspacePath: root, signal: AbortSignal.timeout(4000) }
    const discovered = await new AgentProviderRegistry().get('codex').discoverNativeSession!(context).catch(() => null)
    if (main) {
      expect(discovered?.handle).toEqual({ kind: 'provider', providerId: 'codex', sessionId: 'thread-0', transcriptPath: files[0] })
      await discovered!.assertCurrent()
      await writeFile(files[0]!, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-0', source: 'vscode', thread_source: 'future' } }) + '\n')
      await expect(discovered!.assertCurrent()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
    } else expect(discovered).toBeNull()
    // The different app-server Provider has no declared ThreadSource::User contract.
    if (payloads[0]?.source === 'vscode') expect(await new AgentProviderRegistry().get('traex').discoverNativeSession!(context).catch(() => null)).toBeNull()
    expect(child.exitCode).toBeNull()
  } finally {
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

it('the same locator revalidates one exact peer main, without selecting another main or recent record', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-peer-role-')))
  const paths = [join(root, 'rollout-original.jsonl'), join(root, 'rollout-other.jsonl')]
  await Promise.all(paths.map((path, index) => writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'main-' + index, source: 'vscode', thread_source: 'user' } }) + '\n')))
  // This peer is deliberately not the Run group leader. Only the separately
  // bound-peer contract may use process scope; group discovery remains unchanged.
  const child = spawn(process.execPath, ['-e', `const fs=require('fs'),fds=[fs.openSync(process.argv[1],'r+')];console.log('ready');
    process.stdin.on('data',bytes=>{const cmd=String(bytes).trim();if(cmd==='open')fds[1]=fs.openSync(process.argv[2],'r+');else if(cmd==='close')fs.closeSync(fds[0]);console.log(cmd)});`, ...paths],
    { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await once(child.stdout!, 'data')
    const context = { processId: child.pid!, signal: AbortSignal.timeout(4000) }
    const original = await locateAppServerNativeSession(context, codexMainNativeRecord, 'process')
    expect(original).toMatchObject({ id: 'main-0', file: { processId: child.pid, path: paths[0] } })
    let changed = once(child.stdout!, 'data'); child.stdin!.write('open'); await changed
    await expect(locateAppServerNativeSession(context, codexMainNativeRecord, 'process')).rejects.toMatchObject({ code: 'AGENT_NATIVE_IDENTITY_AMBIGUOUS' })
    changed = once(child.stdout!, 'data'); child.stdin!.write('close'); await changed
    const other = await locateAppServerNativeSession(context, codexMainNativeRecord, 'process')
    expect(other).toMatchObject({ id: 'main-1', file: { path: paths[1] } })
    expect(other?.id).not.toBe(original?.id)
    expect(child.exitCode).toBeNull()
  } finally { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; await rm(root, { recursive: true, force: true }) }
}, 10_000)

it('OS producer counts many writable descriptors as one exact actor/file, without admitting another actor', async () => {
  // A controlled record carrier proves the FD contract; this process is not a
  // vendor backend. The separate original Native/TUI fixture proves the positive.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-dual-fd-'))), path = join(root, 'rollout-dual.jsonl')
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'dual-main', source: 'vscode', thread_source: 'user' } }) + '\n')
  const child = spawn(process.execPath, ['-e', "const fs=require('fs');for(let n=0;n<17;n++)fs.openSync(process.argv[1],'r+');fs.openSync(process.argv[1],'r');console.log('ready');setInterval(()=>{},1000)", path],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(child.stdout!, 'data')
    const signal = AbortSignal.timeout(4000)
    const files = await nativeProcessFiles(child.pid!, signal, 'process')
    expect(files.filter(file => file.path === path && (file.access === 'w' || file.access === 'u'))).toHaveLength(17)
    const found = await new AgentProviderRegistry().get('codex').discoverNativeSession!({ processId: child.pid!, command: process.execPath, args: [], workspacePath: root, signal })
    expect(found?.handle).toMatchObject({ sessionId: 'dual-main', transcriptPath: path }); await found!.assertCurrent()
    expect(child.exitCode).toBeNull()
  } finally { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; await rm(root, { recursive: true, force: true }) }
}, 10_000)
