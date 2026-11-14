import { afterEach, expect, it, vi } from 'vitest'
import { copyFile, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { qualifyCursorPayloadProtocol } from '../src/providers/cursor-native-sources.js'
const native = vi.hoisted(() => ({ path: '', wrongInode: false, startedSec: 0 }))
vi.mock('../src/agent-native-process.js', () => ({
  nativeProcessBirth: vi.fn(async () => JSON.stringify(['darwin', 999, 501, String(native.startedSec), '0'])),
  nativeProcessExecutable: vi.fn(async () => { const file = await stat(native.path, { bigint: true }); return {
    path: native.path, device: String(file.dev), inode: String(file.ino + (native.wrongInode ? 1n : 0n)) } })
}))
const artifact = process.env.AGENTMUX_TEST_CURSOR_ARTIFACT_ROOT
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })
async function fixture(actual: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-cursor-contract-'))); roots.push(root)
  native.path = join(root, 'node'); native.wrongInode = false; native.startedSec = Math.ceil(Date.now()/1000) + 2
  await writeFile(native.path, 'The OS executable observation is a controlled port, no process runs.')
  for (const name of ['cursor-agent', 'index.js', '1706.index.js', '2166.index.js']) {
    if (actual) await copyFile(join(artifact!, name), join(root, name))
    else await writeFile(join(root, name), 'Unqualified native code, regardless of version or body schema.')
  }
  native.startedSec = Math.ceil(Date.now()/1000) + 1
  return { root, context: { command: join(root, 'cursor-agent'), args: [], processId: 999, workspacePath: root } }
}

it('does not qualify a future or arbitrary writer from version text, filenames or the body schema', async () => {
  const f = await fixture(false)
  await expect(qualifyCursorPayloadProtocol(f.context)).rejects.toMatchObject({ code: 'AGENT_PROMPT_PAYLOAD_PROTOCOL_UNCONFIRMED' })
})

it('binds the qualified local artifact to the same original mapped object and Runtime entry, including direct native Node entry', async () => {
  // Exact shipped source is task-local primary evidence, never a fake version
  // reply. On a machine without this artifact only the negative guard is proven.
  let available = true
  try { if (!artifact) throw Error('No selected native artifact'); await stat(join(artifact, 'index.js')) } catch { available = false }
  if (!available) { const f = await fixture(false); await expect(qualifyCursorPayloadProtocol(f.context)).rejects.toThrow(); return }
  const f = await fixture(true)
  const original = await qualifyCursorPayloadProtocol(f.context)
  expect(original).toBeTruthy()
  expect(await qualifyCursorPayloadProtocol({ ...f.context, command: native.path, args: ['--use-system-ca', join(f.root, 'index.js')] })).toBe(original)
  native.wrongInode = true
  await expect(qualifyCursorPayloadProtocol(f.context)).rejects.toThrow()
  native.wrongInode = false
  await writeFile(join(f.root, 'exec-wrapper'), 'unobserved wrapper entry')
  await expect(qualifyCursorPayloadProtocol({ ...f.context, command: join(f.root, 'exec-wrapper') })).rejects.toMatchObject({ code: 'AGENT_PROMPT_PAYLOAD_PROTOCOL_UNCONFIRMED' })
  native.startedSec = Math.floor(Date.now()/1000) - 1
  await expect(qualifyCursorPayloadProtocol(f.context)).rejects.toThrow()
})
