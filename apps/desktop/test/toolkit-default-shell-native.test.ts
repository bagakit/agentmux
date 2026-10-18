import { expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, writeFile, appendFile, stat } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { connectAgentMuxRpc } from '@agentmux/core'
import { connectHostedAgentMux } from '@agentmux/core/hosted'
import type { ToolkitScriptSnapshot } from '@agentmux/core/control'
import { toolkitRuntime } from './helpers/toolkit-runtime.fixture.js'
import { buildDefaultShellFixture } from '../scripts/fixtures/toolkit-default-shell/build.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_TOOLKIT_EVIDENCE!
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
const until = async <T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
): Promise<T> => {
  const end = Date.now() + 15_000
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= end)
      throw new Error('Private default-shell observation unavailable: ' + label)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
function processReceipt(
  child: ChildProcess,
  kind: string,
  errors: () => string,
) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        finish(
          new Error('Private child did not report ' + kind + ': ' + errors()),
        ),
      15_000,
    )
    const receive = (value: any) => {
      if (value?.kind === kind) finish(undefined, value)
      else if (value?.kind === 'failed') finish(new Error(value.message))
    }
    const exit = () =>
      finish(new Error('Private child exited before ' + kind + ': ' + errors()))
    function finish(error?: Error, value?: unknown) {
      clearTimeout(timer)
      child.off('message', receive)
      child.off('error', finish)
      child.off('exit', exit)
      if (error) reject(error)
      else resolve(value)
    }
    child.on('message', receive)
    child.once('error', finish)
    child.once('exit', exit)
  })
}
function start(
  source: { worker: string; cli: string },
  directory: string,
  role: 'host' | 'main',
  shell: string,
  loseReply = false,
) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(AGENTMUX_|CTXMUX_|PRIVATE_DEFAULT_SHELL_)/u.test(key),
    ),
  )
  const child = spawn(
    process.execPath,
    [
      source.worker,
      role,
      directory,
      source.cli,
      resolve(root, 'apps/desktop/resources/toolkit/performance.mjs'),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...clean,
        SHELL: shell,
        TOOLKIT_HOST_MARKER:
          role === 'main'
            ? 'main-only'
            : shell === '/bin/bash'
              ? 'original-host'
              : 'changed-host',
        HOME: join(directory, 'home'),
        AGENTMUX_RUNTIME_DIRECTORY: directory,
        AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
        AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson'),
        AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'),
        ...(loseReply ? { PRIVATE_DEFAULT_SHELL_LOSE_REPLY: '1' } : {}),
      },
    },
  )
  let stderr = ''
  child.stderr!.on('data', (value) => {
    stderr += value
  })
  child.stdout!.resume()
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  )
  return {
    child,
    ready: processReceipt(child, 'ready', () => stderr),
    closed,
    errors: () => stderr,
    async dispose() {
      if (child.exitCode !== null || child.signalCode !== null) return
      const received = processReceipt(child, 'disposed', () => stderr)
      child.send('dispose')
      await received
      expect(await closed).toEqual({ code: 0, signal: null })
    },
  }
}

it('keeps the captured Host shell and original Native Run through lost creation and physical Host/Main restart', async () => {
  const native = await toolkitRuntime(),
    children: ReturnType<typeof start>[] = []
  const directory = native.directory,
    working = join(directory, 'working directory')
  let failure: unknown, proof: unknown
  const readers: Array<{ dispose(): Promise<void> }> = []
  try {
    const source = await buildDefaultShellFixture(
      join(evidence, 'compiled'),
      process.env.AGENTMUX_DEFAULT_SHELL_MUTATION,
    )
    await mkdir(working)
    await mkdir(join(directory, 'home'))
    // The real ConfigStore seeds its normal default document; no fake Toolkit owner.
    const host = start(source, directory, 'host', '/bin/bash', true)
    children.push(host)
    const originalHost = await host.ready
    const main = start(source, directory, 'main', '/bin/false')
    children.push(main)
    const originalMain = await main.ready
    const endpoint = originalMain.endpoint
    async function cli(args: string[], success = true) {
      const child = spawn(
        process.execPath,
        [source.cli, '--endpoint', endpoint, ...args],
        {
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key),
            ),
          ),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (value) => {
        stdout += value
      })
      child.stderr.on('data', (value) => {
        stderr += value
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      await appendFile(
        join(evidence, 'cli.jsonl'),
        JSON.stringify({ args, code, stdout, stderr }) + '\n',
      )
      expect(code, stderr).toBe(success ? 0 : 1)
      if (!success) return { stdout, stderr }
      const frames = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(frames).toHaveLength(1)
      return frames[0]
    }
    const input = join(directory, 'input.json'),
      args = ['--noprofile', '--norc', '-i']
    await writeFile(
      input,
      JSON.stringify({
        name: 'Default shell',
        icon: 'terminal',
        enabled: false,
        statusBar: 'icon',
        mode: 'tui',
        workspacePath: working,
        script: '',
        args,
      }),
    )
    const created = (
      await cli(['toolkit', 'create', 'default-shell', '--input', input])
    ).result.definition
    expect(created).toMatchObject({
      script: '',
      mode: 'tui',
      workspacePath: working,
      args,
    })
    await writeFile(
      input,
      JSON.stringify({
        changes: { script: ' \n\t ', enabled: true },
        expected: { script: '', enabled: false },
      }),
    )
    await cli(['toolkit', 'update', 'default-shell', '--input', input])
    const inspect = async (): Promise<ToolkitScriptSnapshot> =>
      (await cli(['toolkit', 'inspect', 'default-shell'])).result.snapshot
    const unknown = await inspect(),
      original = unknown.admission!
    expect(unknown).toMatchObject({
      state: 'unknown',
      admission: { run: null },
    })
    const creates = async () =>
      (await readFile(join(directory, 'creates.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    const captured = (await creates())[0],
      originalRun = captured.run,
      originalIntent = captured
    expect(originalIntent.createOperationId).toBe(original.executionId)
    expect(originalIntent.cwd).toBe(working)
    expect(originalIntent.args.slice(-4)).toEqual(['/bin/bash', ...args])
    expect(originalIntent.environmentKeys).toContain('TOOLKIT_HOST_MARKER')
    expect(originalRun).toMatchObject({ state: 'running' })
    expect(originalRun.pid).toBeGreaterThan(1)
    expect(await native.activation.client.list()).toHaveLength(1)
    const persisted = JSON.parse(
      await readFile(join(directory, 'toolkit-receipts.json'), 'utf8'),
    )
    expect(
      hash(
        JSON.stringify(persisted.tools['default-shell'].createIntent.prepared),
      ),
    ).toBe(originalIntent.requestSHA256)
    expect(persisted.tools['default-shell'].createIntent.hostId).toBe('local')
    expect(
      (await stat(join(directory, 'toolkit-receipts.json'))).mode & 0o777,
    ).toBe(0o600)
    expect(JSON.stringify(unknown)).not.toContain('TOOLKIT_HOST_MARKER')
    expect(JSON.stringify(unknown)).not.toContain('createIntent')
    await main.dispose()
    await host.dispose()
    const between = await native.activation.client.status(originalRun.runId)
    expect(between).toMatchObject({
      id: originalRun.runId,
      pid: originalRun.pid,
      state: { type: 'running' },
    })
    const nextHost = start(source, directory, 'host', '/bin/zsh')
    children.push(nextHost)
    const changedHost = await nextHost.ready
    const nextMain = start(source, directory, 'main', '/bin/false')
    children.push(nextMain)
    await nextMain.ready
    expect(changedHost.owner.runtimeId).toBe(originalHost.owner.runtimeId)
    expect(changedHost.owner.ownerInstanceId).not.toBe(
      originalHost.owner.ownerInstanceId,
    )
    expect(nextHost.child.pid).not.toBe(host.child.pid)
    expect(nextMain.child.pid).not.toBe(main.child.pid)
    expect(await inspect()).toMatchObject({
      state: 'unknown',
      admission: { executionId: original.executionId, run: null },
    })
    expect(await creates()).toHaveLength(1)
    const rpc = await connectAgentMuxRpc({
      endpoint: { transport: 'unix', path: join(directory, 'control.sock') },
    })
    readers.push(rpc)
    const client = await connectHostedAgentMux({ rpc })
    readers.push(client)
    const currentDefault = await client.prepareTerminal({
      workspacePath: working,
    })
    expect(JSON.parse(currentDefault.launch).request.args.at(-1)).toBe(
      '/bin/zsh',
    )
    expect(
      JSON.parse(currentDefault.launch).request.env.TOOLKIT_HOST_MARKER,
    ).toBe('changed-host')
    await writeFile(
      input,
      JSON.stringify({
        invocationId: original.invocationId,
        expectedRevision: original.definition.revision,
        expectedLatestExecutionId: original.expectedLatestExecutionId,
      }),
    )
    await cli(['toolkit', 'run', 'default-shell', '--input', input])
    const confirmed = await inspect()
    expect(confirmed).toMatchObject({
      state: 'running',
      admission: {
        executionId: original.executionId,
        run: { hostId: 'local', runId: originalRun.runId },
        definition: original.definition,
      },
    })
    const calls = await creates()
    expect(calls.map((value) => value.requestSHA256)).toEqual([
      originalIntent.requestSHA256,
      originalIntent.requestSHA256,
    ])
    expect(calls.map((value) => value.run.runId)).toEqual([
      originalRun.runId,
      originalRun.runId,
    ])
    const attached = await client.attachTerminal(originalRun.runId, 0, 'raw')
    const ref = { runId: originalRun.runId }
    const command =
      'printf "PRIVATE_CWD:%s\\n" "$PWD"; printf "PRIVATE_SHELL:%s\\n" "$BASH_VERSION"; printf "PRIVATE_FLAGS:%s\\n" "$-"; printf "PRIVATE_HOST:%s\\n" "$TOOLKIT_HOST_MARKER"\r'
    await client.writeTerminal(ref, {
      ownerInstanceId: client.runtimeIdentity().instanceId,
      operationId: 'retained-shell-input',
      expectedByte: attached.run.acceptedInputBytes,
      data: command,
    })
    const output = await until(
      () => client.readRunReplay(ref, 0, 'raw'),
      (value) =>
        value.replay
          .map((chunk) => chunk.data)
          .join('')
          .includes('PRIVATE_CWD:' + working),
      'same Run interactive input',
    )
    const text = output.replay.map((chunk) => chunk.data).join('')
    expect(text).toMatch(/PRIVATE_SHELL:[0-9]/u)
    const retainedFlags = text.match(
      /(?:^|[\r\n])PRIVATE_FLAGS:([A-Za-z0-9-]+)(?=[\r\n]|$)/u,
    )?.[1]
    expect(retainedFlags).toContain('i')
    expect(text).toContain('PRIVATE_HOST:original-host')
    expect(output.run).toMatchObject({
      runId: originalRun.runId,
      pid: originalRun.pid,
      state: 'running',
    })
    await writeFile(input, JSON.stringify({ changes: { mode: 'script' } }))
    await cli(['toolkit', 'update', 'default-shell', '--input', input], false)
    expect((await inspect()).admission?.run?.runId).toBe(originalRun.runId)
    // Existing nonempty commands keep the wrapper and exact positional arguments.
    await writeFile(
      input,
      JSON.stringify({
        name: 'Explicit command',
        icon: 'terminal',
        enabled: true,
        statusBar: 'icon',
        mode: 'tui',
        workspacePath: working,
        script: 'printf "POSITION:%s\\n" "$1"; exec cat',
        args: ['literal $value; argument'],
      }),
    )
    await cli(['toolkit', 'create', 'explicit-command', '--input', input])
    const explicit = (await cli(['toolkit', 'inspect', 'explicit-command']))
      .result.snapshot as ToolkitScriptSnapshot
    const explicitIntent = (await creates()).at(-1)
    expect(explicitIntent.args.slice(-5)).toEqual([
      '/bin/sh',
      '-lc',
      'printf "POSITION:%s\\n" "$1"; exec cat',
      'agentmux-toolkit',
      'literal $value; argument',
    ])
    await until(
      () => client.readRunReplay(explicit.admission!.run!, 0, 'raw'),
      (value) =>
        value.replay
          .map((chunk) => chunk.data)
          .join('')
          .includes('POSITION:literal $value; argument'),
      'nonempty positional command',
    )
    // Empty args must be interactive by the real PTY contract, without adding -i.
    await writeFile(
      input,
      JSON.stringify({
        name: 'Plain default shell',
        icon: 'terminal',
        enabled: true,
        statusBar: 'icon',
        mode: 'tui',
        workspacePath: working,
        script: '',
        args: [],
      }),
    )
    await cli(['toolkit', 'create', 'plain-default-shell', '--input', input])
    const plain = (await cli(['toolkit', 'inspect', 'plain-default-shell']))
      .result.snapshot as ToolkitScriptSnapshot
    expect(plain).toMatchObject({
      state: 'running',
      definition: { script: '', args: [] },
    })
    const plainIntent = (await creates()).at(-1)
    expect(plainIntent.args.slice(plainIntent.args.indexOf('--') + 1)).toEqual([
      '/bin/zsh',
    ])
    const plainAttached = await client.attachTerminal(
      plain.admission!.run!.runId,
      0,
      'raw',
    )
    const plainRef = { runId: plainAttached.run.runId }
    await client.writeTerminal(plainRef, {
      ownerInstanceId: client.runtimeIdentity().instanceId,
      operationId: 'plain-default-shell-input',
      expectedByte: plainAttached.run.acceptedInputBytes,
      data: 'printf "PLAIN_FLAGS:%s\\n" "$-"; printf "PLAIN_CWD:%s\\n" "$PWD"\r',
    })
    const plainOutput = await until(
      () => client.readRunReplay(plainRef, 0, 'raw'),
      (value) =>
        value.replay
          .map((chunk) => chunk.data)
          .join('')
          .includes('PLAIN_CWD:' + working),
      'empty-args interactive shell',
    )
    const plainFlags = plainOutput.replay
      .map((chunk) => chunk.data)
      .join('')
      .match(/(?:^|[\r\n])PLAIN_FLAGS:([A-Za-z0-9-]+)(?=[\r\n]|$)/u)?.[1]
    expect(plainFlags).toContain('i')
    expect(plainOutput.run).toMatchObject({
      runId: plainRef.runId,
      state: 'running',
    })
    expect(await native.activation.client.list()).toHaveLength(3)
    for (const [path, digest] of Object.entries(source.inputs))
      expect(hash(await readFile(resolve(root, path))), path).toBe(digest)
    proof = {
      source: relative(root, join(evidence, 'compiled/source.json')),
      originalIntentSHA256: originalIntent.requestSHA256,
      originalRun,
      ownerPids: children.map((value) => value.child.pid),
      ownerIdentityPreserved: true,
      continuedRun: confirmed.admission!.run,
      sameRunInput: output.run,
      retainedInteractiveFlags: retainedFlags,
      defaultChangedTo: '/bin/zsh',
      nonemptyIntentSHA256: explicitIntent.requestSHA256,
      hostEnvironmentFrozen: true,
      emptyArgsInteractive: {
        runId: plainRef.runId,
        argumentCount: 0,
        flags: plainFlags,
        nativeInputConfirmed: true,
      },
      privateReceiptMode: '0600',
      publicIntentAbsent: true,
      actualCli: true,
      scope:
        'Actual CLI, public service, Main owners and RuntimeController, separate Hosted Core and private Native; Electron UI excluded',
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    for (const reader of readers.reverse()) await reader.dispose()
    for (const child of children.slice().reverse()) {
      try {
        await child.dispose()
      } catch {
        if (child.child.exitCode === null && child.child.signalCode === null) {
          child.child.kill('SIGKILL')
          await child.closed
        }
      }
    }
    const corrective = await native.activation.client.list()
    for (const run of corrective) {
      if (run.state.type === 'running')
        await native.activation.client.stop(
          await native.activation.client.prepareStop(run.id),
        )
      await native.activation.client.remove(run.id)
    }
    const remaining = await native.activation.client.list(),
      cleanup = await native.cleanup()
    await writeFile(
      join(evidence, 'native.json'),
      JSON.stringify(
        {
          completed: !failure,
          proof,
          failure: failure ? String(failure) : null,
          childExits: await Promise.all(children.map((value) => value.closed)),
          childErrors: children.map((value) => value.errors()),
          correctiveRunIds: corrective.map((value) => value.id),
          remaining,
          cleanup,
        },
        null,
        2,
      ) + '\n',
    )
    expect(remaining).toEqual([])
    expect(cleanup).toMatchObject({
      childExit: 'confirmed',
      namespace: 'removed',
    })
  }
}, 120_000)
