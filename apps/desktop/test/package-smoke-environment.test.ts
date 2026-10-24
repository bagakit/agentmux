import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { privatePackageSmokeEnvironment } from '../scripts/package-smoke-context.mjs'

// Execute the original private smoke function, with only its filesystem/OS
// boundaries controlled. No production export or alternate launch implementation.
const source = await readFile(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const functions = ast.statements.filter(ts.isFunctionDeclaration)
const smoke = functions.find(node => node.name?.text === 'verifyLaunchServices')!
const dmg = functions.find(node => node.name?.text === 'verifyDmg')!
const main = functions.find(node => node.name?.text === 'main')!
function calls(node: ts.Node, name: string): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) return true
  return ts.forEachChild(node, child => calls(child, name) || undefined) ?? false
}

it.each([undefined, '1'])('LaunchServices smoke uses GUI environment when caller Node mode is %s', async nodeMode => {
  expect(calls(main, 'verifyDmg')).toBe(true); expect(calls(dmg, 'verifyLaunchServices')).toBe(true)
  const app = _hygiene_fixturePath("private/owned/AgentMux.app"), root = _hygiene_fixturePath("private/owned/verification"), runtime = _hygiene_fixturePath("private/owned/runtime")
  const executable = path.join(app, 'Contents/MacOS/AgentMux')
  const caller = { PATH: 'private-system-bin', KEEP_ORIGINAL_VALUE: 'retained',
    AGENTMUX_MESSAGE_QUEUE_PATH: _hygiene_fixturePath('original/messages.ndjson'),
    AGENTMUX_RPC_ENDPOINT: 'unix:original-endpoint', AGENTMUX_ACTOR_SESSION_ID: 'original-agent',
    AGENTMUX_HOOK_TOKEN: 'original-private-token', NODE_OPTIONS: '--inspect',
    HOME: _hygiene_fixturePath('original/home'), ZDOTDIR: _hygiene_fixturePath('original/shell'),
    ...(nodeMode ? { ELECTRON_RUN_AS_NODE: nodeMode } : {}) }
  const original = { ...caller }
  const run = vi.fn(async (command: string) => ({ stdout: '', stderr: '' }))
  const boundaries = {
    privatePackageSmokeEnvironment,
    defaultAgentMuxControlSocketPath: (env: Record<string, string>) => path.join(env.AGENTMUX_RUNTIME_DIRECTORY!, 'control.sock'),
    macosHostService: (input: unknown) => input, macosHostServiceRegistration: async () => null,
    cleanupSmokeHost: async () => ({ status: 'unregistered' }),
    createPrivateRuntimeScope: async () => ({ directory: runtime, socketPath: path.join(runtime, 'ctxmux.sock'),
      daemonPath: path.join(app, 'Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),
      observeOwner: async () => ({}), cleanup: async () => ({ status: 'exited', signals: ['SIGTERM'], exitConfirmed: true }) }),
    writeFile: async () => {},
    sep: path.sep,
    realpath: async (p: string) => p, join: path.join, mkdir: async () => {}, mkdtemp: async () => runtime,
    process: { env: caller, getuid: () => 501, stdout: { write: () => {} } }, PRODUCT_NAME: 'AgentMux', manifest: { version: '0.1.0' },
    processIdsForApplication: async () => [], scopedProcesses: async () => ({ nodeModes: [] }), run,
    assert: (condition: unknown, message: string) => { if (!condition) throw new Error(message) },
    waitForPath: async () => true, waitForProcessExit: async () => [], cleanupProcessScope: async () => [],
    rm: async () => {}, pathExists: async () => false,
    readFile: async (p: string) => JSON.stringify(p.endsWith('desktop-ready.json')
      ? { productName: 'AgentMux', version: '0.1.0', packaged: true, executable }
      : { daemonPath: path.join(app, 'Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'), socketPath: path.join(runtime, 'ctxmux.sock') })
  }
  const invoke = new Function(...Object.keys(boundaries), 'app', 'root', `return (${smoke.getText(ast)})(app, root)`)
  await invoke(...Object.values(boundaries), app, root)
  const opening = run.mock.calls.filter(call => call[0] === 'open')
  expect(opening).toHaveLength(1)
  const [command, args, options] = opening[0] as unknown as [string, string[], {env: Record<string, string>}]
  expect(command).toBe('open'); expect(args).toContain('AGENTMUX_DESKTOP_EXIT_AFTER_READY=1')
  expect(options.env).toMatchObject({ PATH: caller.PATH, HOME: path.join(root, 'user-data/home'),
    ZDOTDIR: path.join(root, 'user-data/home'), AGENTMUX_RUNTIME_DIRECTORY: runtime,
    AGENTMUX_STATE_DIRECTORY: path.join(runtime, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: path.join(root, 'user-data/agent-sessions.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH: path.join(root, 'user-data/global-messages.ndjson') })
  for (const name of ['KEEP_ORIGINAL_VALUE', 'AGENTMUX_RPC_ENDPOINT', 'AGENTMUX_ACTOR_SESSION_ID', 'AGENTMUX_HOOK_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) {
    expect(options.env).not.toHaveProperty(name)
  }
  for (const [name, value] of Object.entries(options.env)) expect(args).toContain(`${name}=${value}`)
  expect(caller).toEqual(original)
})
