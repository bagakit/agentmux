import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentExecutionHelperContext } from '../src/agent-execution-helper.js'
import { AgentExecutionJournal } from '../src/agent-execution-journal.js'
import { runProcess } from '../src/process-runner.js'
import { prepareCodexExecutionHelper } from '../src/providers/codex-execution-helper.js'
import { parseCodexExecutionRunArguments, runCodexExecutionHelper } from '../src/providers/codex-execution-run.js'

vi.mock('../src/process-runner.js', () => ({ runProcess: vi.fn() }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.resetAllMocks(); vi.unstubAllEnvs() })

async function context(role: 'frontend' | 'executor' = 'frontend'): Promise<AgentExecutionHelperContext> {
  const root = await mkdtemp(join(tmpdir(), 'native-helper-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let journalIdentity: string | undefined
  if (role === 'executor') { const journal = await AgentExecutionJournal.open(join(root, 'journal')); journalIdentity = journal.identity; await journal.close() }
  return { bindingId: 'binding-original', providerId: 'codex', role, workspacePath: root, journalDirectory: join(root, 'journal'), executable: process.execPath, createOperationId: 'create-original', ...(role === 'executor' ? { journalIdentity: journalIdentity!, grant: { scope: 'host-user', bindingId: 'binding-original' } as const } : {}) }
}
function io() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() })
  const frames: any[] = []
  const output = new Writable({ write(bytes, _encoding, done) { expect(input.setRawMode).toHaveBeenCalledWith(true); frames.push(JSON.parse(String(bytes))); done() } })
  cleanup.push(async () => { input.destroy(); output.destroy() })
  return { input, output, frames }
}

it('qualifies the stable native version then builds a fixed explicit Node runner invocation', async () => {
  const config = await context('executor')
  vi.mocked(runProcess).mockResolvedValue({ exitCode: 0, stdout: 'codex-cli 0.165.0\n', stderr: '' })
  const plan = await prepareCodexExecutionHelper(config)
  expect(runProcess).toHaveBeenCalledWith(config.executable, ['--version'], expect.objectContaining({ maxOutputBytes: 4096 }))
  expect(plan.command).toBe(process.execPath)
  expect(plan.args[0]).toBe('--disable-warning=ExperimentalWarning')
  expect(plan.args[1]).toMatch(/\/providers\/codex-execution-run\.js$/u)
  expect(parseCodexExecutionRunArguments(plan.args.slice(2))).toEqual(config)
  expect(plan.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
})

it('resolves the exact Host PATH candidate before version qualification and freezes the absolute launch path', async () => {
  const config = await context(), path = join(config.workspacePath, 'codex')
  await writeFile(path, '#!/bin/sh\nexit 0\n'); await chmod(path, 0o700)
  vi.stubEnv('PATH', config.workspacePath)
  config.executable = 'codex'
  vi.mocked(runProcess).mockResolvedValue({ exitCode: 0, stdout: 'codex-cli 0.165.0', stderr: '' })
  const plan = await prepareCodexExecutionHelper(config)
  expect(parseCodexExecutionRunArguments(plan.args.slice(2)).executable).toBe(path)
  expect(runProcess).toHaveBeenCalledWith(path, ['--version'], expect.any(Object))
  expect(config.executable).toBe('codex')
})

it.each([
  { exitCode: 0, stdout: 'codex-cli 0.163.0', stderr: '' },
  { exitCode: 0, stdout: 'codex-cli 0.165.1', stderr: '' },
  { exitCode: 0, stdout: 'codex-cli 0.165.0', stderr: 'unconfirmed launcher' },
  { exitCode: 1, stdout: 'codex-cli 0.165.0', stderr: '' },
])('does not qualify another release or a failed version observation', async result => {
  vi.mocked(runProcess).mockResolvedValue(result)
  await expect(prepareCodexExecutionHelper(await context())).rejects.toThrow('not qualified')
})

it('requires explicit runner arguments and a grant for the exact resource binding', async () => {
  const config = await context('executor')
  expect(() => parseCodexExecutionRunArguments([JSON.stringify(config)])).toThrow('explicit')
  expect(() => parseCodexExecutionRunArguments(['--agentmux-execution-helper', JSON.stringify({ ...config, grant: { scope: 'host-user', bindingId: 'another' } })])).toThrow('exact Host-user')
  const { grant: _grant, ...withoutGrant } = config
  expect(() => parseCodexExecutionRunArguments(['--agentmux-execution-helper', JSON.stringify(withoutGrant)])).toThrow('exact Host-user')
  expect(() => parseCodexExecutionRunArguments(['--agentmux-execution-helper', JSON.stringify({ ...config, executable: 'codex' })])).toThrow('fixed')
})

it('emits frontend ready only after raw mode and leaves ownership to the helper Run', async () => {
  const streams = io(), config = await context()
  const runner = await runCodexExecutionHelper(config, streams)
  cleanup.push(() => runner.close())
  expect(streams.frames).toEqual([{ type: 'ready', url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/u) }])
  streams.input.end()
  expect(streams.input.setRawMode).toHaveBeenCalledTimes(1)
})

it('opens the original executor journal before ready and keeps child stderr private', async () => {
  const streams = io(), config = await context('executor')
  const runner = await runCodexExecutionHelper(config, streams)
  cleanup.push(() => runner.close())
  expect(streams.frames).toEqual([{ type: 'ready', bindingId: config.bindingId, journalIdentity: expect.any(String) }])
  expect((await stat(join(config.journalDirectory, 'operations.identity'))).isFile()).toBe(true)
  expect((await stat(join(config.journalDirectory, 'native-executor.stderr.log'))).mode & 0o777).toBe(0o600)
  streams.input.end()
  expect(streams.input.setRawMode).toHaveBeenCalledTimes(1)
})

it('does not advertise readiness or change the prepared journal on a non-machine terminal', async () => {
  const streams = io(), config = await context('executor'); streams.input.isTTY = false
  const before = await stat(join(config.journalDirectory, 'operations.sqlite'))
  await expect(runCodexExecutionHelper(config, streams)).rejects.toThrow('dedicated raw-capable')
  expect(streams.frames).toEqual([])
  expect((await stat(join(config.journalDirectory, 'operations.sqlite'))).mtimeMs).toBe(before.mtimeMs)
})

it('refuses a missing or replaced original executor journal without advertising readiness', async () => {
  const streams = io(), config = await context('executor')
  const { journalIdentity: _identity, ...withoutIdentity } = config
  expect(() => parseCodexExecutionRunArguments(['--agentmux-execution-helper', JSON.stringify(withoutIdentity)])).toThrow('journal identity')
  await rm(config.journalDirectory, { recursive: true })
  await expect(runCodexExecutionHelper(config, streams)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_MISSING' })
  expect(streams.frames).toEqual([])
  await expect(stat(config.journalDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  const replacement = await AgentExecutionJournal.open(config.journalDirectory); await replacement.close()
  await expect(runCodexExecutionHelper(config, streams)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_INVALID' })
  expect(streams.frames).toEqual([])
})
