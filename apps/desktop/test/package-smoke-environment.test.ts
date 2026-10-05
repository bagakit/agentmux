import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

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
  const caller = { KEEP_ORIGINAL_VALUE: 'retained', ...(nodeMode ? { ELECTRON_RUN_AS_NODE: nodeMode } : {}) }
  const run = vi.fn(async (command: string) => ({ stdout: '', stderr: '' }))
  const boundaries = {
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
  expect(options.env).toEqual({ KEEP_ORIGINAL_VALUE: 'retained' })
  expect(caller).toEqual(nodeMode ? { KEEP_ORIGINAL_VALUE: 'retained', ELECTRON_RUN_AS_NODE: '1' } : { KEEP_ORIGINAL_VALUE: 'retained' })
})
