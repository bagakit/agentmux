import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { AGENT_EXECUTION_GUIDE } from '../src/agent-execution-guide.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import * as generatedGuides from '../src/generated/agentmux-guides.js'

const root = resolve(import.meta.dirname, '../../..')
const core = resolve(root, 'packages/core')
const exec = promisify(execFile)

it('projects the original Markdown body exactly and connects it to both registered help paths', async () => {
  const markdown = await readFile(resolve(core, 'guides/actions/remote-execution.md'), 'utf8')
  const marker = '<!-- amux:content -->\n'
  expect(markdown.split(marker)).toHaveLength(2)
  const body = markdown.split(marker)[1]!.replace(/\n$/u, '')
  expect(body.length).toBeGreaterThan(1000)
  expect(AGENT_EXECUTION_GUIDE).toBe(body)
  for (const path of ['agent.open', 'agent.execution']) {
    const help = agentMuxCommandHelp(path)
    expect(help).not.toBeNull()
    expect(help!.length).toBeGreaterThan(body.length)
    expect(help).toContain(body)
  }
})

it.each(['open', 'execution'])('prints the same complete guide through the actual amux agent %s --help command', async action => {
  const result = await exec(process.execPath, [resolve(core, 'bin/amux'), 'agent', action, '--help'], {
    cwd: core, env: { ...process.env, AGENTMUX_CONTROL_ENDPOINT: '/unavailable-guide-read-must-stay-offline' }
  })
  expect(result.stdout.length).toBeGreaterThan(AGENT_EXECUTION_GUIDE.length)
  expect(result.stdout).toContain(AGENT_EXECUTION_GUIDE)
  expect(result.stdout).toContain(action === 'open' ? 'Usage: amux agent open' : 'amux agent execution inspect')
})

it('executes the published narrow subpath in a browser bundle without Node or unrelated CLI guides', async () => {
  const manifest = JSON.parse(await readFile(resolve(core, 'package.json'), 'utf8'))
  expect(manifest.exports['./agent-execution-guide']).toEqual({
    types: './dist/agent-execution-guide.d.ts', import: './dist/agent-execution-guide.js'
  })
  const bundled = await build({
    absWorkingDir: root,
    stdin: { contents: "export { AGENT_EXECUTION_GUIDE } from '@agentmux/core/agent-execution-guide'", resolveDir: core, sourcefile: 'remote-guide-browser-consumer.js' },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'RemoteExecutionGuide',
    write: false, metafile: true, charset: 'utf8', logLevel: 'silent'
  })
  const inputs = Object.keys(bundled.metafile!.inputs)
  expect(inputs.length).toBeGreaterThan(0)
  expect(inputs).toContain('packages/core/dist/agent-execution-guide.js')
  expect(inputs.filter(path => /(?:^|\/)(?:index|agentmux-cli-help|agentmux-guides-index)\.js$/u.test(path))).toEqual([])
  const nodeImports = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
  for (const input of Object.values(bundled.metafile!.inputs)) {
    for (const imported of input.imports) {
      expect(imported.external).not.toBe(true)
      expect(nodeImports.has(imported.path)).toBe(false)
    }
  }
  expect(bundled.outputFiles).toHaveLength(1)
  const output = bundled.outputFiles[0]!.text
  const context: { RemoteExecutionGuide?: { AGENT_EXECUTION_GUIDE: string } } = {}
  runInNewContext(output, context)
  expect(Object.keys(context.RemoteExecutionGuide!)).toEqual(['AGENT_EXECUTION_GUIDE'])
  expect(context.RemoteExecutionGuide!.AGENT_EXECUTION_GUIDE).toBe(AGENT_EXECUTION_GUIDE)

  // Inspect emitted string values, so escaping/formatting cannot hide an aggregate guide payload.
  const strings: string[] = []
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile('remote-guide-browser.js', output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS))
  expect(strings).toContain(AGENT_EXECUTION_GUIDE)
  const unrelated = Object.values(generatedGuides).filter(document => document.id !== 'actions/remote-execution')
  expect(unrelated.length).toBeGreaterThan(0)
  for (const document of unrelated) expect(strings, document.id).not.toContain(document.text)
})
