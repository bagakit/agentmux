import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const native = vi.hoisted(() => ({ files: vi.fn(), birth: vi.fn(), image: vi.fn(), run: vi.fn() }))
vi.mock('../src/agent-native-process.js', () => ({ nativeProcessFiles: native.files, nativeProcessBirth: native.birth, openNativeProcessImage: native.image }))
vi.mock('../src/process-runner.js', () => ({ runProcess: native.run }))
import { createCodexPromptExecutionTransportVerifier, readCodexPromptExecutionEvidence } from '../src/providers/codex-prompt-execution-evidence.js'
import type { AgentProviderPromptExecutionContext } from '../src/agent-provider.js'

let root: string | undefined
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; vi.resetAllMocks() })
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'amux-current-writer-test-'))
  const path = join(root, 'rollout-private.jsonl'), imagePath = join(root, 'mapped-native')
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'native', cli_version: '0.159.0' } }) + '\n')
  const bytes = Buffer.from('EXACT_OPENED_NATIVE_IMAGE')
  await writeFile(imagePath, bytes)
  const context: AgentProviderPromptExecutionContext = { args: [], workspacePath: root, processId: 123,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native', transcriptPath: path } }
  context.nativeSourceId = (await readCodexPromptExecutionEvidence(context))!.sourceId
  const file = await open(path); const stat = await file.stat({ bigint: true }); await file.close()
  const owner = { processId: 124, processGroup: 123, descriptor: '27', path, device: stat.dev, inode: stat.ino, access: 'u' }
  native.files.mockResolvedValue([owner]); native.birth.mockImplementation(async (pid: number) => `BIRTH:${pid}`)
  const assertCurrent = vi.fn().mockResolvedValue(undefined)
  native.image.mockImplementation(async () => ({ file: await open(imagePath), identity: 'EXACT_IMAGE', assertCurrent }))
  const copies: string[] = []
  native.run.mockImplementation(async (command: string, args: string[]) => {
    expect(args).toEqual(['--version']); expect(command).not.toBe(imagePath)
    expect(await readFile(command)).toEqual(bytes); copies.push(command)
    return { stdout: 'codex-cli 0.160.1\n', stderr: '', exitCode: 0 }
  })
  return { context, path, owner, assertCurrent, copies, verify: createCodexPromptExecutionTransportVerifier() }
}

describe('current writer authority after restoration', () => {
  it('uses the current exact image rather than a historical creator version and deletes its private copy', async () => {
    const f = await fixture(); expect(await f.verify(f.context)).toBe(true)
    expect(native.image).toHaveBeenCalledWith(124, expect.any(AbortSignal))
    expect(native.run).toHaveBeenCalledTimes(1); await expect(readFile(f.copies[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse((await readFile(f.path, 'utf8')).trim()).payload.cli_version).toBe('0.159.0')
  })
  it('caches only one image version and revalidates writer authorization for every operation', async () => {
    const f = await fixture(); expect(await f.verify(f.context)).toBe(true); expect(await f.verify(f.context)).toBe(true)
    expect(native.run).toHaveBeenCalledTimes(1); expect(native.files).toHaveBeenCalledTimes(4)
    native.files.mockResolvedValue([]); expect(await f.verify(f.context)).toBe(false); expect(native.run).toHaveBeenCalledTimes(1)
  })
  it('does not cache an unsupported current writer as a transport authorization', async () => {
    const f = await fixture(); native.run.mockResolvedValue({ stdout: 'codex-cli 0.159.0\n', stderr: '', exitCode: 0 })
    await expect(f.verify(f.context)).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED' })
    native.files.mockResolvedValue([]); expect(await f.verify(f.context)).toBe(false)
  })
  it('probes a changed current image and keeps a previous version from authorizing it', async () => {
    const f = await fixture(); expect(await f.verify(f.context)).toBe(true)
    native.image.mockImplementation(async () => ({ file: await open(join(root!, 'mapped-native')), identity: 'REPLACEMENT_IMAGE', assertCurrent: f.assertCurrent }))
    native.run.mockResolvedValue({ stdout: 'codex-cli 0.159.0\n', stderr: '', exitCode: 0 })
    await expect(f.verify(f.context)).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED' }); expect(native.run).toHaveBeenCalledTimes(2)
  })
  it.each(['root', 'native'])('rejects changed %s process birth after the image probe', async (which) => {
    const f = await fixture(); let n = 0
    native.birth.mockImplementation(async (pid: number) => { if (pid === (which === 'root' ? 123 : 124)) return String(++n); return `BIRTH:${pid}` })
    expect(await f.verify(f.context)).toBe(false)
  })
  it('rejects source replacement even when SessionMeta names the same native Session', async () => {
    const f = await fixture(); expect(await f.verify({ ...f.context, nativeSourceId: 'different-inode-proof' })).toBe(false)
    expect(native.image).not.toHaveBeenCalled()
  })
  it('rejects a second native writer arriving during the version probe', async () => {
    const f = await fixture(); native.files.mockResolvedValueOnce([f.owner]).mockResolvedValue([f.owner, { ...f.owner, processId: 125 }])
    expect(await f.verify(f.context)).toBe(false)
  })
  it('does not authorize a remote daemon or a replaced mapped image', async () => {
    const f = await fixture(); expect(await f.verify({ ...f.context, args: [("--remote=" + (fixturePath("private/socket")))] })).toBe(false)
    expect(native.image).not.toHaveBeenCalled(); f.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('IMAGE_CHANGED'))
    await expect(f.verify(f.context)).rejects.toThrow('IMAGE_CHANGED')
    await expect(readFile(f.copies[0] ?? fixturePath("private/no-copy"))).rejects.toBeDefined()
  })
  it('does not cache a failed probe and preserves a later healthy version observation', async () => {
    const f = await fixture(); native.run.mockResolvedValueOnce({ stdout: 'not a version\n', stderr: '', exitCode: 0 })
    await expect(f.verify(f.context)).rejects.toMatchObject({ code: 'AGENT_PROMPT_IMMEDIATE_UNSUPPORTED' })
    expect(await f.verify(f.context)).toBe(true); expect(native.run).toHaveBeenCalledTimes(2)
  })
})
