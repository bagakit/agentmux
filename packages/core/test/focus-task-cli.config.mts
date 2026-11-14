import { defineConfig } from 'vitest/config'
import { build } from 'esbuild'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'truncate-cohort': ['packages/core/src/focus-task-guidance.ts', 'offset < task.selection.references.length', 'offset < Math.min(task.selection.references.length, FOCUS_READ_MAX_REFERENCES)'],
  'broaden-empty': ['packages/core/src/focus-task-guidance.ts', "return [parseFocusParams('focus.read', task)]", "return [parseFocusParams('focus.read', { ...task, selection: { kind: 'all' } })]"],
  'unsafe-shell': ['packages/core/src/focus-task-guidance.ts', 'shellQuote(JSON.stringify(parsed))', 'JSON.stringify(parsed)'],
  'missing-cli-scope': ['packages/core/src/agentmux-cli-commands.ts', "parseFocusParams('focus.read', await readControlJsonInput(value(f, '--input', true)!, 'Exact Focus read'))", "parseFocusParams('focus.read', { ...await readControlJsonInput(value(f, '--input', true)!, 'Exact Focus read') as object, selection: { kind: 'all' } })"]
} as const
const selected = process.env.AGENTMUX_FOCUS_TASK_MUTANT as keyof typeof variants | undefined
if (selected && !variants[selected]) throw Error('Unknown Focus task source inverse')
const owners = new Set(['packages/core/src/focus-task-guidance.ts', 'packages/core/src/focus-control.ts', 'packages/core/src/agentmux-cli-commands.ts',
  'packages/core/src/agentmux-cli-help.ts', 'packages/core/src/agentmux-cli-module-skills.ts', 'packages/core/src/generated/agentmux-guides.ts', 'packages/core/src/generated/agentmux-guides-index.ts'])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const applied = new Set<string>()
function load(original: string, path: string, consumer: string) {
  let code = original
  if (selected && path === variants[selected][0]) {
    const [, before, after] = variants[selected]
    if (code.split(before).length !== 2) throw Error('One precise Focus task inverse anchor is required')
    code = code.replace(before, after); applied.add(consumer)
  }
  if (owners.has(path) && process.env.AGENTMUX_FOCUS_TASK_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_TASK_LOADED,
    JSON.stringify({ path, consumer, original_sha256: sha(original), loaded_sha256: sha(code), mutant: code === original ? null : selected }) + '\n')
  return code
}
const output = resolve(root, 'packages/core/.tmp/focus-task-cli', selected ?? 'baseline')
mkdirSync(output, { recursive: true })
process.env.AGENTMUX_FOCUS_TEST_CLI = resolve(output, 'agentmux.mjs')
const bundle = await build({ entryPoints: [resolve(root, 'packages/core/src/agentmux.ts')], outfile: process.env.AGENTMUX_FOCUS_TEST_CLI,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', metafile: true,
  plugins: [{ name: 'actual-focus-cli-source', setup(build) { build.onLoad({ filter: /packages\/core\/src\/.*\.ts$/ }, args => ({
    contents: load(readFileSync(args.path, 'utf8'), relative(root, args.path), 'cli'), loader: 'ts' })) } }] })
if (!Object.keys(bundle.metafile!.inputs).some(path => path.endsWith('src/agentmux-cli-commands.ts'))) throw Error('Actual CLI consumer was not bundled')
if (selected === 'missing-cli-scope' && !applied.has('cli')) throw Error('CLI inverse was not consumed')

export default defineConfig({ root, cacheDir: resolve(output, 'vite-cache'), plugins: [{ name: 'actual-focus-task-source', enforce: 'pre', transform(original, id) {
  const path = relative(root, id.split('?')[0]!), code = load(original, path, 'vitest')
  return original === code ? undefined : { code, map: null }
}, buildEnd() { if (selected && !applied.size) throw Error('Focus task inverse owner was not loaded') } }], test: {
  include: ['packages/core/test/focus-task-cli.test.ts'], maxWorkers: 1, fileParallelism: false,
  passWithNoTests: false, testTimeout: 20000, hookTimeout: 20000
} })
