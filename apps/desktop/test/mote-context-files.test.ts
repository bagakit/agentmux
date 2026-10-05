const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { DEFAULT_MOTE_AGENT_INSTRUCTIONS, DEFAULT_TOPIC_AGENT_INSTRUCTIONS } from '../src/shared/topic-agent-instructions'
import type { WorkspaceRecord } from '../src/shared/contracts'

vi.mock('electron', () => ({ nativeImage: {}, app: { getPath: () => _hygiene_fixturePath("not-used-by-this-test") } }))
const readFault = vi.hoisted(() => ({ grow: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (String(args[0]).endsWith('/AGENTS.md')) {
      const read = handle.read.bind(handle)
      handle.read = (async (...values: any[]) => {
        const result = await (read as any)(...values)
        if (readFault.grow) { readFault.grow = false; await actual.appendFile(args[0], 'Concurrent original edit.\n') }
        return result
      }) as typeof handle.read
    }
    return handle
  } }
})
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-context-'))); roots.push(root)
  const path = join(root, 'scratch'); await mkdir(path)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path, kind: 'folder' }
  return { root, workspace, owner: new ScratchTopics() }
}

it('creates distinct short Topic and Mote entry points and delivers them even when Wiki injection is disabled', async () => {
  const h = await fixture()
  for (const mote of [false, true]) {
    const topic = await h.owner.ensure(h.workspace, 'launcher:entry-' + mote, undefined, mote)
    const expected = mote ? DEFAULT_MOTE_AGENT_INSTRUCTIONS : DEFAULT_TOPIC_AGENT_INSTRUCTIONS
    expect(await readFile(join(topic.physicalDirectoryPath!, 'AGENTS.md'), 'utf8')).toBe(expected)
    await h.owner.setWikiEnabled(h.workspace, topic.id, false)
    const prepared = await h.owner.prepareAgent(h.workspace, topic.id, { providerId: 'codex', sessionId: 'new-' + mote })
    expect(prepared.prompt).toContain(expected)
    expect(prepared.prompt).toMatch(/Original AGENTS.md \(version [0-9a-f]{16}; loaded for this new Session only\)/)
    expect(prepared.prompt).toContain('Topic Wiki injection is disabled')
    if (!mote) expect(prepared.prompt).not.toContain('## Remember usefully')
  }
})

it('keeps custom entry, personality, behavior, settings and evidence byte-for-byte after repeated ensure', async () => {
  const h = await fixture(), topic = await h.owner.ensureMote(h.workspace, 'launcher:custom-entry')
  const files = { 'AGENTS.md': '# My guide\r\n\r\nPreserve my exact custom rule.\r\n', 'SOUL.md': '# My SOUL\nCustom identity.\n',
    'BEHAVIOR.md': '# Original preferences\n', 'MOTE.md': '# Original settings\n', 'outcome/result.md': '# Original result\n' }
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(topic.physicalDirectoryPath!, path), bytes)
  const fresh = new ScratchTopics()
  await fresh.ensureMote(h.workspace, topic.id); await fresh.ensureMote(h.workspace, topic.id)
  const prepared = await fresh.prepareAgent(h.workspace, topic.id, { providerId: 'claude', sessionId: 'custom-entry-new' })
  expect(prepared.prompt).toContain(files['AGENTS.md']); expect(prepared.prompt).toContain(files['SOUL.md'])
  for (const [path, bytes] of Object.entries(files)) expect(await readFile(join(topic.physicalDirectoryPath!, path), 'utf8')).toBe(bytes)
})

it('prepares an old non-primary Mote with missing AGENTS from its original kind, not the default ensure flag', async () => {
  const h = await fixture(), mote = await h.owner.ensureMote(h.workspace, 'launcher:old-mote-without-entry')
  await rm(join(mote.physicalDirectoryPath!, 'AGENTS.md'))
  const prepared = await new ScratchTopics().prepareAgent(h.workspace, mote.id, { providerId: 'codex', sessionId: 'old-new' })
  expect(prepared.snapshot.kind).toBe('mote')
  expect(prepared.prompt).toContain(DEFAULT_MOTE_AGENT_INSTRUCTIONS)
  expect(prepared.prompt).not.toContain('This is a shared Topic, not a persistent Mote persona.')
})

it('does not guess Topic instructions when the original object kind is unknown', async () => {
  const h = await fixture(), mote = await h.owner.ensureMote(h.workspace, 'launcher:unknown-kind')
  await rm(join(mote.physicalDirectoryPath!, 'AGENTS.md')); await rm(join(mote.physicalDirectoryPath!, 'SOUL.md'))
  const outside = join(h.root, 'outside-soul'); await writeFile(outside, '# foreign'); await symlink(outside, join(mote.physicalDirectoryPath!, 'SOUL.md'))
  const prepared = await h.owner.prepareAgent(h.workspace, mote.id, { providerId: 'codex', sessionId: 'unknown-kind-new' })
  expect(prepared.snapshot.kind).toBeUndefined()
  expect(prepared.prompt).toContain('Original AGENTS.md was not loaded:')
  expect(prepared.prompt).not.toContain(DEFAULT_TOPIC_AGENT_INSTRUCTIONS)
})

it('reports a concurrent context edit as unloaded and preserves the actual later bytes', async () => {
  const h = await fixture(), mote = await h.owner.ensureMote(h.workspace, 'launcher:read-drift')
  readFault.grow = true
  const prepared = await h.owner.prepareAgent(h.workspace, mote.id, { providerId: 'codex', sessionId: 'drift-new' })
  expect(readFault.grow).toBe(false)
  expect(prepared.prompt).toContain('The original context file changed during reading')
  expect(prepared.prompt).not.toContain(DEFAULT_MOTE_AGENT_INSTRUCTIONS)
  expect(await readFile(join(mote.physicalDirectoryPath!, 'AGENTS.md'), 'utf8')).toContain('Concurrent original edit.')
})

it('loads the exact 64 KiB boundary without truncating the original text', async () => {
  const h = await fixture(), mote = await h.owner.ensureMote(h.workspace, 'launcher:boundary-entry')
  const content = 'x'.repeat(65535) + '\n'; await writeFile(join(mote.physicalDirectoryPath!, 'AGENTS.md'), content)
  const prepared = await h.owner.prepareAgent(h.workspace, mote.id, { providerId: 'codex', sessionId: 'boundary-new' })
  expect(prepared.prompt).toContain(content)
  expect(prepared.prompt).not.toContain('was not loaded:')
})

it('delivers exact guide bytes through the real RuntimeController launch and original Core creation, keeping human input separate', async () => {
  const { injectedContextCore } = await import('./helpers/injected-context-core')
  const { RuntimeController } = await import('../src/main/runtime-controller')
  const { DEFAULT_CONFIG } = await import('../src/main/config-store')
  const h = await fixture(), mote = await h.owner.ensureMote(h.workspace, 'launcher:actual-context-consumer')
  const text = '# Actual guide\nKeep the source distinction.\n'
  await writeFile(join(mote.physicalDirectoryPath!, 'AGENTS.md'), text)
  const coreRoot = join(h.root, 'private-core'); await mkdir(coreRoot)
  const f = await injectedContextCore(coreRoot)
  const runtime = new RuntimeController(f.store, async () => { throw new Error('Unrelated Host connection must not be created') })
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [h.workspace], executors: {
    fixture: { providerId: 'claude' as const, label: 'Private fixture', command: 'private-fixture', args: [], env: {}, injectAgentMuxGuide: false } } }
  runtime.commit({ hosts: [{ id: 'local', config: config.hosts.find(host => host.id === 'local')!, client: f.core,
    executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const create = vi.spyOn(f.core, 'createAgentWithDelivery')
  try {
    const result = await runtime.launchAgent({ hostId: 'local', executorId: 'fixture', workspacePath: h.workspace.path,
      agentSessionId: 'actual-context-session', scratchTopicId: mote.id, createOperationId: 'actual-context-create', prompt: 'Original human request' }, config)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ prompt: 'Original human request', workspacePath: mote.physicalDirectoryPath })
    expect(create.mock.calls[0]![0].agentMuxNote).toContain(text)
    const saved = f.core.agentSession(result.created.agentSessionId)
    expect(JSON.stringify(await f.core.sessionTimeline(result.created.agentSessionId))).toContain('Keep the source distinction.')
    expect(saved.workspacePath).toBe(mote.physicalDirectoryPath)
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
  } finally { await runtime.dispose(); await f.dispose(); vi.unstubAllEnvs() }
})

it.each(['symlink', 'oversized', 'invalid-utf8', 'directory'] as const)('keeps new-session input available with explicit unloaded AGENTS: %s', async kind => {
  const h = await fixture(), topic = await h.owner.ensureMote(h.workspace, 'launcher:bad-entry-' + kind)
  const file = join(topic.physicalDirectoryPath!, 'AGENTS.md'); await rm(file)
  if (kind === 'symlink') { const outside = join(h.root, 'outside.md'); await writeFile(outside, 'FOREIGN PRIVATE CONTEXT'); await symlink(outside, file) }
  else if (kind === 'directory') await mkdir(file)
  else await writeFile(file, kind === 'oversized' ? 'x'.repeat(65537) : Buffer.from([0xc3, 0x28]))
  const prepared = await h.owner.prepareAgent(h.workspace, topic.id, { providerId: 'codex', sessionId: 'bad-new-' + kind })
  expect(prepared.prompt).toContain('Original AGENTS.md was not loaded:')
  expect(prepared.prompt).toContain('Existing work, input and healthy Agents remain available.')
  expect(prepared.prompt).not.toContain('FOREIGN PRIVATE CONTEXT')
  expect(prepared.absolutePath).toBe(topic.physicalDirectoryPath)
})

it('uses the current exact Mote guide without crossing Mote homes or rewriting a previous prepared context', async () => {
  const h = await fixture(), a = await h.owner.ensureMote(h.workspace, 'launcher:guide-a'), b = await h.owner.ensureMote(h.workspace, 'launcher:guide-b')
  await writeFile(join(a.physicalDirectoryPath!, 'AGENTS.md'), '# Guide A\nExact original knowledge A.\n')
  await writeFile(join(b.physicalDirectoryPath!, 'AGENTS.md'), '# Guide B\nForeign knowledge B.\n')
  const first = await h.owner.prepareAgent(h.workspace, a.id, { providerId: 'codex', sessionId: 'first' })
  await writeFile(join(a.physicalDirectoryPath!, 'AGENTS.md'), '# Guide A updated\nCorrected knowledge A.\n')
  const second = await new ScratchTopics().prepareAgent(h.workspace, a.id, { providerId: 'claude', sessionId: 'second' })
  expect(first.prompt).toContain('Exact original knowledge A.'); expect(first.prompt).not.toContain('Corrected knowledge A.')
  expect(second.prompt).toContain('Corrected knowledge A.'); expect(second.prompt).not.toContain('Exact original knowledge A.')
  expect(first.prompt + second.prompt).not.toContain('Foreign knowledge B.')
})
