import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, realpath, readFile, writeFile, chmod, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executionHelperTerminalLaunch } from '../src/agent-execution-helper.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('exec isolates bootstrap and live stderr while retaining argv, cwd and the same process identity', async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-helper ' argv-")); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const marker = join(root, 'must-not-exist'), script = join(root, 'native helper.mjs')
  const value = `space ' quote \" ; $(touch ${marker}) 中文`
  await writeFile(script, `process.stderr.write('native bootstrap warning\\n');\nprocess.stdout.write(JSON.stringify({type:'ready',pid:process.pid,cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');\nsetTimeout(()=>{process.stderr.write('live native warning\\n');process.stdout.write(JSON.stringify({type:'response',ok:true})+'\\n')},10)\n`)
  await writeFile(join(root, 'helper-executor.stderr.log'), 'original diagnostic\n')
  const launch = await executionHelperTerminalLaunch({ command: process.execPath, args: [script, value], env: {} }, { journalDirectory: root, role: 'executor' })
  const result = await promisify(execFile)(launch.command, launch.args, { cwd: root })
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  expect(result.stderr).toBe('')
  expect(frames).toMatchObject([{ type: 'ready', cwd: await realpath(root), args: [value] }, { type: 'response', ok: true }])
  expect(await readFile(join(root, 'helper-executor.stderr.log'), 'utf8')).toBe('original diagnostic\nnative bootstrap warning\nlive native warning\n')
  expect((await stat(join(root, 'helper-executor.stderr.log'))).mode & 0o777).toBe(0o600)
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['claude', 'codex'] as const)('%s: actual Core Provider preparation freezes stderr isolation once and never rewrites a retained helper', async providerId => {
  const root = await mkdtemp(join(tmpdir(), 'amux-stdio-preparation-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', root); vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const executable = join(root, 'vendor cli')
  await writeFile(executable, '#!/bin/sh\nprintf "codex-cli 0.165.0\\n"\n'); await chmod(executable, 0o700)
  const base = new AgentProviderRegistry().get(providerId)
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), providers: [{ ...base, executable, catalog: { ...base.catalog, executable } }] }); cleanup.push(() => client.dispose())
  const prepare = vi.spyOn(client, 'prepareTerminal').mockImplementation(async input => ({ createOperationId: input.createOperationId!, workspacePath: input.workspacePath, launch: JSON.stringify({ createOperationId: input.createOperationId, request: { program: input.command, args: input.args, cwd: input.workspacePath, env: { ...input.env, AGENTMUX_LIFECYCLE_OPERATION_ID: input.createOperationId }, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] } }) }))
  const input = { providerId, role: 'executor' as const, bindingId: 'original-binding', agentSessionId: 'original-session', createOperationId: 'original-operation', workspacePath: root, grant: { scope: 'host-user' as const, bindingId: 'original-binding' } }
  const first = await client.prepareAgentExecutionHelper(input)
  const launch = JSON.parse(first.prepared.launch).request
  expect(launch.program).toBe('/bin/sh')
  expect(launch.args).toEqual(expect.arrayContaining([process.execPath, '--agentmux-execution-helper']))
  expect(launch.args[1]).toBe('stderr=$1; shift; exec "$@" 2>> "$stderr"')
  expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(prepare).toHaveBeenCalledTimes(1)
  await writeFile(join(root, 'agent-execution', 'original-binding', 'helper-executor.stderr.log'), 'retained diagnostic\n')
  expect(await client.prepareAgentExecutionHelper(input)).toEqual(first)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(await readFile(join(root, 'agent-execution', 'original-binding', 'helper-executor.stderr.log'), 'utf8')).toBe('retained diagnostic\n')
})
