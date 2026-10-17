const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
const { fixtureCivil: _hygiene_fixtureCivil } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild')
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { DEFAULT_MOTE_AGENT_INSTRUCTIONS, DEFAULT_TOPIC_AGENT_INSTRUCTIONS, DEFAULT_MOTE_MEMORY } from '../src/shared/topic-agent-instructions'
import { goalRoleGuidanceContract } from '@agentmux/core/goal-role-guidance'
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
    'BEHAVIOR.md': '# Original preferences\n', 'MOTE.md': '# Original settings\n', 'MEMORY.md': '# Custom memory\r\nKeep my source and organization.\r\n', 'outcome/result.md': '# Original result\n' }
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
  expect(prepared.prompt).not.toContain('"$AGENTMUX_CLI" topic --skill')
  expect(prepared.prompt).not.toContain('"$AGENTMUX_CLI" mote --skill')
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

it.each([
  { kind: 'topic', custom: false }, { kind: 'topic', custom: true },
  { kind: 'mote', custom: false }, { kind: 'mote', custom: true }
] as const)('delivers current $kind methods with custom=$custom through real RuntimeController and Core, preserving originals', async ({ kind, custom }) => {
  const { injectedContextCore } = await import('./helpers/injected-context-core')
  const { RuntimeController } = await import('../src/main/runtime-controller')
  const { DEFAULT_CONFIG } = await import('../src/main/config-store')
  const h = await fixture(), topic = await h.owner.ensure(h.workspace, 'launcher:actual-context-consumer', undefined, kind === 'mote')
  const text = custom ? '# Actual guide\r\nKeep the source distinction and my existing organization.\r\n'
    : await readFile(join(topic.physicalDirectoryPath!, 'AGENTS.md'), 'utf8')
  const memory = ("# Memory\nConfirmed scoped choice, source original fixture, " + _hygiene_fixtureCivil(10, 12) + ".\n")
  const originalResult = '# Existing result\r\nOriginal scope and source stay here.\r\n'
  await writeFile(join(topic.physicalDirectoryPath!, 'outcome/retained.md'), originalResult)
  if (kind === 'mote') await writeFile(join(topic.physicalDirectoryPath!, 'MEMORY.md'), memory)
  if (custom) {
    await writeFile(join(topic.physicalDirectoryPath!, 'AGENTS.md'), text)
    await h.owner.setWikiEnabled(h.workspace, topic.id, false)
  }
  else {
    // The default file is a discoverable entry, while the full contract stays with the Goal owner.
    // Compare against the independent canonical module, not a second copy of the entry's prose.
    expect(text).not.toContain(goalRoleGuidanceContract())
    expect(text).not.toContain('## Executor responsibilities')
    expect(text).not.toContain('## Management responsibilities')
    expect(text).toContain('"$AGENTMUX_CLI" ' + kind + ' --skill')
  }
  const originalTopic = await readFile(join(topic.physicalDirectoryPath!, 'topic.md'))
  const originalWiki = await readFile(join(topic.physicalDirectoryPath!, '.agentmux/topic-wiki.md'))
  const originalSoul = kind === 'mote' ? await readFile(join(topic.physicalDirectoryPath!, 'SOUL.md')) : null
  const coreRoot = join(h.root, 'private-core'); await mkdir(coreRoot)
  const f = await injectedContextCore(coreRoot)
  const runtime = new RuntimeController(f.store, async () => { throw new Error('Unrelated Host connection must not be created') })
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [h.workspace], executors: {
    fixture: { providerId: 'claude' as const, label: 'Private fixture', command: 'private-fixture', args: [], env: {}, injectAgentMuxGuide: false } } }
  runtime.commit({ hosts: [{ id: 'local', config: config.hosts.find(host => host.id === 'local')!, client: f.core,
    executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const create = vi.spyOn(f.core, 'createAgentWithDelivery')
  const userInput = '  比较当前决定与更正。 <original> & &amp;\r\nKeep my exact request.  \n'
  try {
    const result = await runtime.launchAgent({ hostId: 'local', executorId: 'fixture', workspacePath: h.workspace.path,
      agentSessionId: 'actual-context-session', scratchTopicId: topic.id, createOperationId: 'actual-context-create', prompt: userInput }, config)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ prompt: userInput, workspacePath: topic.physicalDirectoryPath })
    expect(create.mock.calls[0]![0].agentMuxNote).toContain(text)
    const saved = f.core.agentSession(result.created.agentSessionId)
    const timeline = await f.core.sessionTimeline(result.created.agentSessionId)
    const system = timeline.items.filter(item => item.kind === 'system_message').map(item => item.content).join('\n\n')
    expect(system).toContain(text)
    expect(system).toContain('"$AGENTMUX_CLI" ' + kind + ' --skill')
    expect(system).toMatch(/confirmed[\s\S]*decision[\s\S]*correction[\s\S]*result/i)
    expect(system).toMatch(/maintain|update/i)
    if (kind === 'mote') {
      expect(system).toContain(memory)
      expect(system).toContain('mote playbook pmo')
      expect(system).toContain('original knowledge, reusable methods and short memory index')
      expect(system).toContain('Read current linked methods for later relevant work and revise them from real feedback.')
      if (!custom) expect(system).toContain('for cooperation, active memory and method improvement, ideas and own-task reminders.')
      expect(system).not.toContain('"$AGENTMUX_CLI" topic --skill')
    } else {
      expect(system).not.toContain('Knowledge for Mote')
      expect(system).not.toContain('mote playbook pmo')
    }
    if (custom) {
      expect(system).toContain('Topic Wiki injection is disabled')
      expect(system).not.toContain('## Routing')
    }
    // Detailed methods stay in the public module rather than repeating an entire handbook at launch.
    expect(system).not.toContain('## Remember at useful moments')
    expect(timeline.items.filter(item => item.kind === 'user_message').map(item => item.content)).toEqual([userInput])
    expect(saved.workspacePath).toBe(topic.physicalDirectoryPath)
    expect(await readFile(join(topic.physicalDirectoryPath!, 'AGENTS.md'), 'utf8')).toBe(text)
    expect(await readFile(join(topic.physicalDirectoryPath!, 'topic.md'))).toEqual(originalTopic)
    expect(await readFile(join(topic.physicalDirectoryPath!, '.agentmux/topic-wiki.md'))).toEqual(originalWiki)
    expect(await readFile(join(topic.physicalDirectoryPath!, 'outcome/retained.md'), 'utf8')).toBe(originalResult)
    if (kind === 'mote') {
      expect(await readFile(join(topic.physicalDirectoryPath!, 'SOUL.md'))).toEqual(originalSoul)
      expect(await readFile(join(topic.physicalDirectoryPath!, 'MEMORY.md'), 'utf8')).toBe(memory)
    } else expect(await readFile(join(topic.physicalDirectoryPath!, 'MEMORY.md')).catch(error => error.code)).toBe('ENOENT')
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


it('supplements only missing Mote memory including old non-primary Motes, without creating Topic memory', async () => {
  const h = await fixture(), a = await h.owner.ensureMote(h.workspace, 'launcher:old-memory'), topic = await h.owner.ensure(h.workspace, 'launcher:ordinary-context')
  expect(await readFile(join(a.physicalDirectoryPath!, 'MEMORY.md'), 'utf8')).toBe(DEFAULT_MOTE_MEMORY)
  expect(await readFile(join(topic.physicalDirectoryPath!, 'MEMORY.md')).catch(error => error.code)).toBe('ENOENT')
  await writeFile(join(topic.physicalDirectoryPath!, 'MEMORY.md'), 'A Topic file is not Mote recall.')
  expect((await h.owner.prepareAgent(h.workspace, topic.id, {providerId:'codex',sessionId:'ordinary-new'})).prompt).not.toContain('A Topic file is not Mote recall.')
  await rm(join(a.physicalDirectoryPath!, 'MEMORY.md'))
  const fresh = await new ScratchTopics().prepareAgent(h.workspace, a.id, {providerId:'codex',sessionId:'old-memory-new'})
  expect(fresh.prompt).toContain(DEFAULT_MOTE_MEMORY)
  expect(fresh.prompt).toContain('Knowledge for Mote ' + a.id)
})

it('loads current original memory, keeps Motes isolated and does not reuse withdrawn recall text', async () => {
  const h = await fixture(), a = await h.owner.ensureMote(h.workspace, 'launcher:memory-a'), b = await h.owner.ensureMote(h.workspace, 'launcher:memory-b')
  const file = join(a.physicalDirectoryPath!, 'MEMORY.md')
  await writeFile(file, '# Memory A\nWithdraw this exact knowledge.\n')
  await writeFile(join(b.physicalDirectoryPath!, 'MEMORY.md'), '# Memory B\nFOREIGN MOTE MEMORY\n')
  const first = await h.owner.prepareAgent(h.workspace, a.id, {providerId:'codex',sessionId:'memory-first'})
  await writeFile(file, '# Memory A\nCorrection: use the current confirmed choice. Source: user correction.\n')
  const corrected = await new ScratchTopics().prepareAgent(h.workspace, a.id, {providerId:'claude',sessionId:'memory-corrected'})
  expect(first.prompt).toContain('Withdraw this exact knowledge.')
  expect(corrected.prompt).toContain('Correction: use the current confirmed choice.')
  expect(corrected.prompt).not.toContain('Withdraw this exact knowledge.')
  await writeFile(file, '# Memory A\nWithdrawn source: memory-first. No recall text.\n')
  const withdrawn = await h.owner.prepareAgent(h.workspace, a.id, {providerId:'codex',sessionId:'memory-withdrawn'})
  expect(withdrawn.prompt).toContain('Withdrawn source: memory-first.')
  expect(withdrawn.prompt).not.toContain('Correction: use the current confirmed choice.')
  expect(first.prompt + corrected.prompt + withdrawn.prompt).not.toContain('FOREIGN MOTE MEMORY')
  expect(withdrawn.prompt).toMatch(/Original MEMORY.md \(version [0-9a-f]{16}; loaded for this new Session only\)/)
})

it.each(['symlink', 'oversized', 'invalid-utf8', 'directory'] as const)('keeps original input available when memory cannot be loaded: %s', async kind => {
  const h = await fixture(), mote = await h.owner.ensureMote(h.workspace, 'launcher:bad-memory-' + kind)
  const file = join(mote.physicalDirectoryPath!, 'MEMORY.md'); await rm(file)
  if (kind === 'symlink') { const outside = join(h.root, 'foreign-memory'); await writeFile(outside, 'FOREIGN MEMORY SECRET'); await symlink(outside, file) }
  else if (kind === 'directory') await mkdir(file)
  else await writeFile(file, kind === 'oversized' ? 'x'.repeat(65537) : Buffer.from([0xc3, 0x28]))
  const prepared = await h.owner.prepareAgent(h.workspace, mote.id, {providerId:'codex',sessionId:'bad-memory-new-' + kind})
  expect(prepared.prompt).toContain('Original MEMORY.md was not loaded:')
  expect(prepared.prompt).not.toContain('FOREIGN MEMORY SECRET')
  expect(prepared.prompt).toContain(DEFAULT_MOTE_AGENT_INSTRUCTIONS)
  expect(prepared.absolutePath).toBe(mote.physicalDirectoryPath)
})

it('keeps original memory available across actual private client process restarts', async () => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util')
  const h = await fixture(), mote = await h.owner.ensureMote(h.workspace, 'launcher:process-memory')
  const output = resolve('apps/desktop/.tmp/mote-memory/new-session-child.mjs'), stub = resolve('.tmp/mote-memory/electron-stub.mjs')
  await mkdir(resolve('apps/desktop/.tmp/mote-memory'), {recursive:true}); await mkdir(resolve('.tmp/mote-memory'), {recursive:true}); await writeFile(stub, 'export const nativeImage = {};')
  await build({stdin:{contents:`import {ScratchTopics} from './apps/desktop/src/main/scratch-topics.ts';
    const input=JSON.parse(process.argv[2]);const prepared=await new ScratchTopics().prepareAgent(input.workspace,input.id,{providerId:'codex',sessionId:input.sessionId});console.log(JSON.stringify({pid:process.pid,prompt:prepared.prompt}));`,resolveDir:process.cwd(),loader:'ts'},
    outfile:output,platform:'node',format:'esm',bundle:true,packages:'external',alias:{electron:stub},logLevel:'silent'})
  const run = promisify(execFile), memory = join(mote.physicalDirectoryPath!, 'MEMORY.md')
  await writeFile(memory, '# Memory\nOriginal process knowledge.\n')
  const one = JSON.parse((await run(process.execPath,[output,JSON.stringify({workspace:h.workspace,id:mote.id,sessionId:'process-one'})],{timeout:15000})).stdout)
  await writeFile(memory, '# Memory\nCorrected after process exit.\n')
  const two = JSON.parse((await run(process.execPath,[output,JSON.stringify({workspace:h.workspace,id:mote.id,sessionId:'process-two'})],{timeout:15000})).stdout)
  expect(one.pid).not.toBe(two.pid); expect(one.prompt).toContain('Original process knowledge.')
  expect(two.prompt).toContain('Corrected after process exit.');expect(two.prompt).not.toContain('Original process knowledge.')
})

it('starts with blank Mote defaults, then carries public Files corrections across actual Core discussions', async () => {
  const { AgentMuxControlServer } = await import('../../../packages/core/src/public-rpc-server')
  const { connectAgentMuxRpc } = await import('../../../packages/core/src/public-rpc-client')
  const { FileReadOwner } = await import('../src/main/file-read-owner'), { WorkspaceFiles } = await import('../src/main/workspace-files')
  const { DEFAULT_MOTE_SOUL } = await import('../src/shared/scratch-topics')
  const { DEFAULT_MOTE_BEHAVIOR } = await import('../src/shared/mote-behavior')
  const h = await fixture(), mote = await h.owner.ensureMote(h.workspace, 'launcher:public-memory')
  const {homeZoneId,directoryIdentity}=await import('../src/shared/space-addresses')
  const zone = {zoneId:homeZoneId(directoryIdentity('local',mote.identityDirectoryPath!)),kind:'temporary',workspaceId:h.workspace.id,hostId:'local',directoryPath:mote.physicalDirectoryPath!}
  const files = new WorkspaceFiles(id => ({id,kind:'local',label:'Private local',run:vi.fn(),exposeLoopbackPort:async port=>port,dispose:async()=>{}}))
  const owner = new FileReadOwner({catalog:async()=>({zones:[zone],bindings:[]} as any),workspace:id=>id===h.workspace.id?h.workspace:undefined,topicForDirectory:(workspace,directory)=>h.owner.readForDirectory(workspace,directory),files})
  let discussionCore: import('@agentmux/core').AgentMuxClient | null = null
  const server = new AgentMuxControlServer({socketPath:join(h.root,'memory.sock'),files:owner,
    coreClients:()=>discussionCore ? [{hostId:'local',client:discussionCore}] : []})
  await server.start()
  const client = await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  try {
    const params = {zoneId:zone.zoneId,path:'MEMORY.md',expectedResource:{hostId:'local',workspaceId:h.workspace.id,workspacePath:h.workspace.path}}
    const original = await client.call('file.read',params)
    expect(original.result.status).toBe('read'); if(original.result.status!=='read'||!original.resource)throw Error('Expected original memory')
    expect(original.resource.zonePath).toBe(mote.physicalDirectoryPath)
    const defaults = { 'SOUL.md': DEFAULT_MOTE_SOUL, 'AGENTS.md': DEFAULT_MOTE_AGENT_INSTRUCTIONS,
      'MEMORY.md': DEFAULT_MOTE_MEMORY, 'BEHAVIOR.md': DEFAULT_MOTE_BEHAVIOR }
    for (const [name, content] of Object.entries(defaults)) expect(await readFile(join(mote.physicalDirectoryPath!, name), 'utf8')).toBe(content)
    expect(original.result.document.content).toBe(DEFAULT_MOTE_MEMORY)
    // Exercise the same compiled command as other public CLI consumers; bundling a second CLI
    // changes its module initialization semantics and does not qualify the shipped artifact.
    const cli = process.env.AGENTMUX_TEST_OBJECT_CLI ?? resolve('packages/core/bin/amux')
    const preference = 'Preference: start with the conclusion.'
    const commitment = 'Open commitment: review the original experiment when its result is ready.'
    const source = 'Source: explicit user choice, ' + _hygiene_fixtureCivil(10, 12) + ', this Mote only.'
    const methodPath = 'outcome/compare-experiments.md'
    const methodLink = '[Compare small experiments](' + methodPath + ')'
    const method = '# Compare small experiments\n\nSource: explicit correction in this private discussion, ' + _hygiene_fixtureCivil(10, 12) + ', this Mote only.\n\nApplicability: early comparison when an observable baseline is available.\nMethod: compare one measurable outcome before broadening the experiment.\nCounterexamples: none recorded yet; do not infer universal applicability.\n\nRetained evidence: the original two experiment descriptions remain with their source.\n'
    const revisedMethod = method.replace('Applicability: early comparison when an observable baseline is available.',
      'Applicability: early comparison only when the same observable baseline and observation window are available.')
      .replace('Counterexamples: none recorded yet; do not infer universal applicability.',
        'Counterexample: unequal observation windows made the first comparison misleading. Source: the later private experiment result. Align the windows before applying this method; otherwise leave the comparison unknown.')
    const content = '# Memory\n' + preference + '\n' + source + '\n\n' + commitment + '\nSource: explicit request, ' + _hygiene_fixtureCivil(10, 12) + ', this private discussion in this Mote only.\n\nMethod: ' + methodLink + ' — early comparisons with an observable baseline; read current applicability and counterexamples before reuse.\n'
    const {spawn}=await import('node:child_process')
    const writes: string[] = []
    type Caller = { agentSessionId: string; capability: string }
    async function command(args:string[], input = '', caller?:Caller) {
      return await new Promise<{code:number|null;body:any}>((resolve,reject)=>{
        const child=spawn(process.execPath,[cli,...args],{env:{...process.env,AGENTMUX_RPC_ENDPOINT:'unix:'+server.path,
          AGENTMUX_AGENT_SESSION_ID:caller?.agentSessionId,AGENTMUX_AGENT_CAPABILITY:caller?.capability,AGENTMUX_ENV:undefined},stdio:['pipe','pipe','pipe']})
        let output='',errors='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>errors+=bytes);child.on('error',reject)
        child.on('close',code=>{try{resolve({code,body:JSON.parse(output||errors)})}catch{reject(Error(errors||output))}});child.stdin.end(input)
      })
    }
    async function save(text:string, expectedRevision:string) {
      writes.push(text)
      return command(['file','write','--zone',zone.zoneId,'--path','MEMORY.md','--resource',JSON.stringify(original.resource),'--expected-revision',expectedRevision],text)
    }
    const { injectedContextCore } = await import('./helpers/injected-context-core')
    const { RuntimeController } = await import('../src/main/runtime-controller')
    const { DEFAULT_CONFIG } = await import('../src/main/config-store')
    const coreRoot = join(h.root, 'original-discussions'); await mkdir(coreRoot)
    const f = await injectedContextCore(coreRoot)
    discussionCore = f.core
    const authorize = vi.spyOn(f.core, 'authorizeRetainedAgentCaller')
    const runtime = new RuntimeController(f.store, async () => { throw Error('No unrelated Host') })
    const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [h.workspace], executors: {
      fixture: { providerId: 'claude' as const, label: 'Private context fixture', command: 'private-fixture', args: [], env: {}, injectAgentMuxGuide: false } } }
    runtime.commit({ hosts: [{ id: 'local', config: config.hosts.find(host => host.id === 'local')!, client: f.core,
      executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    const create = vi.spyOn(f.core, 'createAgentWithDelivery')
    const userInput = '  帮我比较两个实验方案。 <original> & &amp;\r\nKeep my exact request.  \n'
    const launch = async (id: string, body: string | null, topic = mote) => {
      const result = await runtime.launchAgent({ hostId: 'local', executorId: 'fixture', workspacePath: h.workspace.path,
        agentSessionId: id, scratchTopicId: topic.id, createOperationId: 'create-' + id, prompt: userInput }, config)
      const input = create.mock.calls.at(-1)![0]
      expect(input.prompt).toBe(userInput)
      expect(input.workspacePath).toBe(topic.physicalDirectoryPath)
      const timeline = await f.core.sessionTimeline(result.created.agentSessionId)
      const system = timeline.items.filter(item => item.kind === 'system_message').map(item => item.content).join('\n\n')
      expect(system.length).toBeGreaterThan(0)
      expect(timeline.items.filter(item => item.kind === 'user_message').map(item => item.content)).toEqual([userInput])
      if (body !== null) {
        expect(input.agentMuxNote!.split(body)).toHaveLength(2)
        expect(system.split(body)).toHaveLength(2) // Exact current MEMORY appears once in real Core context.
      }
      expect(f.core.agentSession(result.created.agentSessionId).workspacePath).toBe(topic.physicalDirectoryPath)
      const nativeInput = f.start.mock.calls.at(-1)![0] as { cwd: string; env: Record<string,string> }
      expect(nativeInput.env.AGENTMUX_AGENT_SESSION_ID).toBe(result.created.agentSessionId)
      expect(nativeInput.env.AGENTMUX_AGENT_CAPABILITY).toEqual(expect.any(String))
      return { sid: result.created.agentSessionId, system, timeline: JSON.stringify(timeline),
        caller: { agentSessionId: nativeInput.env.AGENTMUX_AGENT_SESSION_ID!, capability: nativeInput.env.AGENTMUX_AGENT_CAPABILITY! } }
    }
    async function readLinkedMethod(discussion: Awaited<ReturnType<typeof launch>>, expected:string, revision:string,
      resource: import('@agentmux/core').FileReadResource) {
      expect(discussion.system).toContain(methodLink)
      expect(discussion.system).not.toContain(expected) // The detailed method stays on demand in its original file.
      const read = await command(['file','read','--zone',zone.zoneId,'--path',methodPath,'--host','local',
        '--workspace',h.workspace.id,'--workspace-path',h.workspace.path], '', discussion.caller)
      expect(read.code).toBe(0)
      expect(read.body.result.resource).toEqual(resource)
      expect(read.body.result.result).toMatchObject({status:'read',document:{content:expected,revision}})
      expect(authorize.mock.calls.at(-1)?.[1]).toBe(discussion.sid)
      return read.body.result
    }
    try {
      // Controlled file writes prove delivery, not autonomous model memory.
      // This is the first actual Core Session, before any preference/knowledge save.
      expect(writes).toEqual([]); expect(create).not.toHaveBeenCalled()
      const blank = await launch('blank-first-discussion', DEFAULT_MOTE_MEMORY)
      expect(blank.system).toContain(DEFAULT_MOTE_SOUL)
      expect(blank.system).toContain(DEFAULT_MOTE_AGENT_INSTRUCTIONS)
      expect(blank.system).toContain('No entries have been added to this index yet.')
      expect(blank.system).toContain('an empty index is not an empty knowledge library')
      expect(blank.system).toContain('mote --skill'); expect(blank.system).toContain('mote playbook pmo')
      expect(blank.system).toContain('original knowledge, reusable methods and short memory index')
      expect(blank.system).toContain('Read current linked methods for later relevant work and revise them from real feedback.')
      expect(blank.system).toContain('for cooperation, active memory and method improvement, ideas and own-task reminders.')
      expect(blank.system).not.toContain('## Remember at useful moments')
      expect(blank.system).not.toContain('## Agree on the work')
      expect(blank.system).not.toContain(goalRoleGuidanceContract())
      expect(blank.system).not.toContain(preference); expect(blank.system).not.toContain(commitment)
      expect(writes).toEqual([]); expect(create).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledTimes(1)
      for (const [name, text] of Object.entries(defaults)) expect(await readFile(join(mote.physicalDirectoryPath!, name), 'utf8')).toBe(text)

      // The harness writes the method, then uses each real Core-issued identity to read it.
      // No model or extra Agent is involved; a successful read is not evidence of adherence.
      const absent = await client.call('file.read',{...params,path:methodPath})
      expect(absent.result.status).toBe('deleted'); expect(absent.resource).not.toBeNull()
      const createdMethod = await command(['file','create','--input','-'], JSON.stringify({zoneId:zone.zoneId,path:methodPath,
        expectedResource:absent.resource,expectedRevision:null,content:method}))
      expect(createdMethod.code).toBe(0); expect(createdMethod.body.result.result.status).toBe('written')
      const methodRead = await client.call('file.read',{...params,path:methodPath})
      expect(methodRead.resource).toEqual(absent.resource)
      expect(methodRead.result).toMatchObject({status:'read',document:{content:method,revision:createdMethod.body.result.result.revision}})

      const saved=await save(content, original.result.document.revision)
      expect(saved.code).toBe(0);expect(saved.body.result.result.status).toBe('written')
      const confirmed=await client.call('file.read',params)
      expect(confirmed.resource).toEqual(original.resource)
      expect(confirmed.result).toMatchObject({status:'read',document:{content,revision:saved.body.result.result.revision}})
      const first = await launch('memory-before-correction', content)
      expect(first.system).toContain(preference); expect(first.system).toContain(source); expect(first.system).toContain(commitment)
      await readLinkedMethod(first,method,createdMethod.body.result.result.revision,absent.resource!)
      const denied = await command(['file','read','--zone',zone.zoneId,'--path',methodPath,'--host','local',
        '--workspace',h.workspace.id,'--workspace-path',h.workspace.path], '', {...first.caller,capability:'not-an-issued-capability'})
      expect(denied.code).not.toBe(0); expect(denied.body.error.code).toBe('AGENT_CAPABILITY_INVALID')
      const stale=await save('Old revision must not resurrect removed knowledge.', original.result.document.revision)
      expect(stale.code).toBe(1);expect(stale.body.result.result.status).toBe('conflict')
      expect(await readFile(join(mote.physicalDirectoryPath!,'MEMORY.md'),'utf8')).toBe(content)

      const correction = 'Preference: start with one concrete example.'
      const corrected = content.replace(preference, correction)
      const methodChange = await command(['file','write','--zone',zone.zoneId,'--path',methodPath,'--resource',JSON.stringify(absent.resource),
        '--expected-revision',createdMethod.body.result.result.revision], revisedMethod, first.caller)
      expect(methodChange.code).toBe(0); expect(methodChange.body.result.result.status).toBe('written')
      const currentMethod = await client.call('file.read',{...params,path:methodPath})
      expect(currentMethod.resource).toEqual(absent.resource)
      expect(currentMethod.result).toMatchObject({status:'read',document:{content:revisedMethod,revision:methodChange.body.result.result.revision}})
      const staleMethod = await command(['file','write','--zone',zone.zoneId,'--path',methodPath,'--resource',JSON.stringify(absent.resource),
        '--expected-revision',createdMethod.body.result.result.revision], method, first.caller)
      expect(staleMethod.code).toBe(1); expect(staleMethod.body.result.result.status).toBe('conflict')
      const changed = await save(corrected, saved.body.result.result.revision)
      expect(changed.code).toBe(0); expect(changed.body.result.result.status).toBe('written')
      const reread = await client.call('file.read', params)
      expect(reread.resource).toEqual(original.resource)
      expect(reread.result).toMatchObject({ status: 'read', document: { content: corrected, revision: changed.body.result.result.revision } })
      const second = await launch('memory-after-correction', corrected)
      expect(second.system).toContain(correction); expect(second.system).toContain(source)
      expect(second.system).toContain(commitment); expect(second.system).not.toContain(preference)
      await readLinkedMethod(second,revisedMethod,methodChange.body.result.result.revision,absent.resource!)
      expect(await readFile(join(mote.physicalDirectoryPath!,methodPath),'utf8')).toBe(revisedMethod)
      const withdrawn = corrected.replace(correction, 'Withdrawn source: the earlier preference. No recall text.')
      const removed = await save(withdrawn, changed.body.result.result.revision)
      expect(removed.code).toBe(0); expect(removed.body.result.result.status).toBe('written')
      const withdrawalRead = await client.call('file.read', params)
      expect(withdrawalRead.resource).toEqual(original.resource)
      expect(withdrawalRead.result).toMatchObject({ status: 'read', document: { content: withdrawn, revision: removed.body.result.result.revision } })
      const third = await launch('memory-after-withdrawal', withdrawn)
      expect(third.system).not.toContain(preference); expect(third.system).not.toContain(correction)
      expect(third.system).toContain('Withdrawn source: the earlier preference.'); expect(third.system).toContain(commitment)
      expect(JSON.stringify(await f.core.sessionTimeline(blank.sid))).toBe(blank.timeline)
      expect(JSON.stringify(await f.core.sessionTimeline(first.sid))).toBe(first.timeline)
      expect(JSON.stringify(await f.core.sessionTimeline(second.sid))).toBe(second.timeline)
      expect(await readFile(join(mote.physicalDirectoryPath!, 'MEMORY.md'), 'utf8')).toBe(withdrawn)
      const oldWrite = await save(corrected, changed.body.result.result.revision)
      expect(oldWrite.code).toBe(1); expect(oldWrite.body.result.result.status).toBe('conflict')
      expect((await client.call('file.read', params)).result).toMatchObject({ status: 'read', document: { content: withdrawn, revision: removed.body.result.result.revision } })

      const foreignMote = await h.owner.ensureMote(h.workspace, 'launcher:foreign-blank-memory')
      const foreign = await launch('foreign-mote-discussion', DEFAULT_MOTE_MEMORY, foreignMote)
      const plainTopic = await h.owner.ensure(h.workspace, 'launcher:plain-memory-isolation')
      const ordinary = await launch('ordinary-topic-discussion', null, plainTopic)
      expect(foreign.system).toContain(DEFAULT_MOTE_AGENT_INSTRUCTIONS)
      expect(ordinary.system).toContain(DEFAULT_TOPIC_AGENT_INSTRUCTIONS)
      expect(ordinary.system).not.toContain('Knowledge for Mote')
      expect(ordinary.system).not.toContain('mote playbook pmo')
      expect([foreign.system, ordinary.system]).toHaveLength(2)
      for (const system of [foreign.system, ordinary.system]) {
        expect(system).not.toContain(preference); expect(system).not.toContain(correction)
        expect(system).not.toContain(commitment); expect(system).not.toContain('Withdrawn source: the earlier preference.')
        expect(system).not.toContain(methodLink); expect(system).not.toContain(method); expect(system).not.toContain(revisedMethod)
      }
      expect(new Set([blank.sid, first.sid, second.sid, third.sid, foreign.sid, ordinary.sid]).size).toBe(6)
      expect(create).toHaveBeenCalledTimes(6); expect(f.start).toHaveBeenCalledTimes(6); expect(f.stop).not.toHaveBeenCalled()
      for (const name of ['SOUL.md', 'AGENTS.md', 'BEHAVIOR.md'] as const) expect(await readFile(join(mote.physicalDirectoryPath!, name), 'utf8')).toBe(defaults[name])
    } finally { await runtime.dispose(); await f.dispose(); vi.unstubAllEnvs() }
  }finally{await client.dispose();await server.stop()}
}, 15000)
