import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexPromptTransportPreparation } from '../src/providers/codex-prompt-transport-preparation.js'
import { readCodexPromptExecutionEvidence } from '../src/providers/codex-prompt-execution-evidence.js'
import type { AgentProviderPromptExecutionContext } from '../src/agent-provider.js'

const native = vi.hoisted(() => ({ owners: [22] as number[], birth: 'writer-birth', image: 'writer-image', rootBirth: 'root-birth', path: '',
  device: 0n, inode: 0n, reads: 0 }))
vi.mock('../src/agent-native-process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agent-native-process.js')>(),
  nativeProcessBirth: async (pid: number) => pid === 11 ? native.rootBirth : native.birth,
  nativeProcessFiles: async () => {
    native.reads++
    return native.owners.map(processId => ({ processId, path: native.path, device: native.device, inode: native.inode, access: 'w' }))
  },
  openNativeProcessImage: async () => ({ identity: native.image, assertCurrent: async () => {}, file: { close: async () => {} } })
}))
let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined })
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'amux-transport-source-'))
  const path = join(directory, 'native.jsonl')
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'native-session' } }) + '\n')
  const source = await stat(path, { bigint: true })
  Object.assign(native, { owners: [22], birth: 'writer-birth', image: 'writer-image', rootBirth: 'root-birth', path,
    device: source.dev, inode: source.ino, reads: 0 })
  const signal = new AbortController().signal
  const context: AgentProviderPromptExecutionContext & { signal: AbortSignal } = { processId: 11, args: [], workspacePath: directory,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-session', transcriptPath: path }, signal }
  const evidence = await readCodexPromptExecutionEvidence(context)
  expect(evidence).not.toBeNull()
  context.nativeSourceId = evidence!.sourceId
  return { context, path }
}

describe('Provider startup transport observation', () => {
  it('rechecks a false original verifier without producing input, and never caches a true authorization', async () => {
    const f = await fixture(); let eligible = false
    const verify = vi.fn(async () => { if (verify.mock.calls.length === 2) eligible = true; return eligible })
    const prepared = await createCodexPromptTransportPreparation(verify)(f.context)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(prepared?.nativeSourceId).toBe(f.context.nativeSourceId)
    eligible = false
    expect(await prepared!.verifyCurrentTransport(f.context)).toBe(false)
  })

  it('waits for the exact first writer, rather than treating an absent startup writer as permanent failure', async () => {
    const f = await fixture(); native.owners = []
    const pending = createCodexPromptTransportPreparation(async () => true)(f.context)
    setTimeout(() => { native.owners = [22] }, 10)
    const prepared = await pending
    expect(prepared?.nativeSourceId).toBe(f.context.nativeSourceId)
    expect(native.reads).toBeGreaterThan(1)
  })

  it.each(['writer-pid', 'writer-birth', 'writer-image', 'root-birth', 'multiple-writers', 'source'])(
    'rejects changed %s on the final current observation', async kind => {
      const f = await fixture(), prepared = await createCodexPromptTransportPreparation(async () => true)(f.context)
      if (kind === 'writer-pid') native.owners = [33]
      if (kind === 'writer-birth') native.birth = 'another-birth'
      if (kind === 'writer-image') native.image = 'another-image'
      if (kind === 'root-birth') native.rootBirth = 'another-root-birth'
      if (kind === 'multiple-writers') native.owners = [22, 33]
      if (kind === 'source') { await rm(f.path); await writeFile(f.path, JSON.stringify({ type: 'session_meta', payload: { id: 'another-session' } }) + '\n') }
      expect(await prepared!.verifyCurrentTransport(f.context)).toBe(false)
    })

  it('refuses a declared remote transport before observing a local writer', async () => {
    const f = await fixture(), verify = vi.fn(async () => true)
    expect(await createCodexPromptTransportPreparation(verify)({ ...f.context, args: ['--remote=ws://private.invalid'] })).toBeNull()
    expect(native.reads).toBe(0); expect(verify).not.toHaveBeenCalled()
  })
})
