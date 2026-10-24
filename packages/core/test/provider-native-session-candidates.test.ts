import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { discoverAppServerNativeSession } from '../src/providers/app-server-native-session.js'
import { discoverClaudeNativeSession } from '../src/providers/claude-native-session.js'
import { codexMainNativeRecord } from '../src/providers/codex-native-record-role.js'
import type { AgentProviderNativeSessionDiscovery } from '../src/types.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const candidateList = (value: AgentProviderNativeSessionDiscovery | null) => {
  expect(value?.candidates, 'Several writable main records expose explicit choices, never an inferred current thread').toBeDefined()
  return value!.candidates!
}

async function expectPresent(witness: { assertPresent(): Promise<void> }) {
  const result = await witness.assertPresent().then(() => ({ present: true }), error => ({ error }))
  expect(result, 'An independently selected main retains its original membership').toEqual({ present: true })
}

/** Real OS file holders, deliberately not a vendor backend. Native protocol tests
 * establish the vendor producer separately; these tests vary its file contract. */
async function fixture(provider: 'codex' | 'claude', opened = [0, 1]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-native-candidates-')))
  const paths = ['main-a', 'main-b', 'child-a', 'child-b', 'grandchild-a'].map(id => join(root, provider === 'codex' ? `rollout-${id}.jsonl` : `${id}.jsonl`))
  const write = async (index: number, main = index < 2) => {
    const id = ['main-a', 'main-b', 'child-a', 'child-b', 'grandchild-a'][index]!
    const parent = ['main-a', 'main-b', 'main-a', 'main-b', 'child-a'][index]!
    const record = provider === 'codex'
      ? { type: 'session_meta', payload: { id, source: main ? 'vscode' : { subagent: { thread_spawn: { parent_thread_id: parent } } }, thread_source: 'user' } }
      : { type: 'user', sessionId: id, isSidechain: !main, message: { role: 'user', content: 'Private source record' } }
    await writeFile(paths[index]!, JSON.stringify(record) + '\n')
  }
  await Promise.all(paths.map((_, index) => write(index)))
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs'),readline=require('node:readline'),paths=JSON.parse(process.argv[1]),fds=new Map();
    for(const n of JSON.parse(process.argv[2]))fds.set(n,fs.openSync(paths[n],'r+'));console.log('ready');
    readline.createInterface({input:process.stdin}).on('line',line=>{const [action,n]=line.split(' '),index=Number(n);if(action==='open')fds.set(index,fs.openSync(paths[index],'r+'));else{fs.closeSync(fds.get(index));fds.delete(index)}console.log(line)});`, JSON.stringify(paths), JSON.stringify(opened)],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended }; await rm(root, { recursive: true }) })
  await once(child.stdout!, 'data')
  const controller = new AbortController()
  const context = { processId: child.pid!, command: process.execPath, args: [], env: {}, workspacePath: root, signal: controller.signal }
  const discover = () => provider === 'codex' ? discoverAppServerNativeSession(context, 'codex', codexMainNativeRecord) : discoverClaudeNativeSession(context)
  const control = async (action: 'open' | 'close', index: number) => { const answered = once(child.stdout!, 'data'); child.stdin!.write(`${action} ${index}\n`); await answered }
  return { paths, write, discover, control, controller, child }
}

it.each(['codex', 'claude'] as const)('%s offers verified main choices and keeps selected membership when another main closes', async provider => {
  const f = await fixture(provider, [0, 1, 2, 3, 4]), candidates = candidateList(await f.discover())
  expect(candidates.map(value => value.handle.sessionId).sort()).toEqual(['main-a', 'main-b'])
  expect(candidates.every(value => !('assertCurrent' in value))).toBe(true)
  const selected = candidates.find(value => value.handle.sessionId === 'main-b')!
  await expectPresent(selected)
  await f.control('close', 0)
  await expectPresent(selected)
  const single = await f.discover()
  expect(single?.handle?.sessionId).toBe('main-b')
  if (!single?.assertCurrent || !single.assertPresent) throw new Error('The remaining member needs both uniqueness and membership checks')
  await single.assertCurrent()
  await f.control('open', 0)
  await expectPresent({ assertPresent: single.assertPresent })
  await expect(single.assertCurrent()).rejects.toMatchObject({ code: 'AGENT_NATIVE_IDENTITY_AMBIGUOUS' })
  expect(f.child.exitCode).toBeNull()
})

it('keeps each Codex candidate child family separate, including grandchildren', async () => {
  const f = await fixture('codex', [0, 1, 2, 3, 4]), candidates = candidateList(await f.discover())
  expect(candidates.find(value => value.handle.sessionId === 'main-a')?.childSessionIds).toEqual(['child-a', 'grandchild-a'])
  expect(candidates.find(value => value.handle.sessionId === 'main-b')?.childSessionIds).toEqual(['child-b'])
})

it.each(['codex', 'claude'] as const)('%s keeps a unique original membership witness when a second main appears', async provider => {
  const f = await fixture(provider, [0]), single = await f.discover()
  expect(single?.handle?.sessionId).toBe('main-a')
  if (!single?.assertCurrent || !single.assertPresent) throw new Error('Expected the unique source witness')
  await f.control('open', 1)
  await expectPresent({ assertPresent: single.assertPresent })
  await expect(single.assertCurrent()).rejects.toMatchObject({ code: 'AGENT_NATIVE_IDENTITY_AMBIGUOUS' })
})

it.each(['codex', 'claude'] as const)('%s refuses the selected original after its path is replaced despite a matching ID', async provider => {
  const f = await fixture(provider), chosen = candidateList(await f.discover()).find(value => value.handle.sessionId === 'main-b')!
  await rename(f.paths[1]!, f.paths[1]! + '.original')
  await f.write(1)
  await expect(chosen.assertPresent()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect(f.child.exitCode).toBeNull()
})

it.each(['codex', 'claude'] as const)('%s does not promote a changed selected role or borrow another main', async provider => {
  const f = await fixture(provider), chosen = candidateList(await f.discover()).find(value => value.handle.sessionId === 'main-b')!
  await f.write(1, false)
  await expect(chosen.assertPresent()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect(f.child.exitCode).toBeNull()
})

it.each(['codex', 'claude'] as const)('%s keeps cancellation local to the reader and leaves its original writer alive', async provider => {
  const f = await fixture(provider), chosen = candidateList(await f.discover())[0]!, reason = new Error('Owned source read cancelled')
  f.controller.abort(reason)
  await expect(chosen.assertPresent()).rejects.toBe(reason)
  await expect(f.discover()).rejects.toBe(reason)
  expect(f.child.exitCode).toBeNull()
})
