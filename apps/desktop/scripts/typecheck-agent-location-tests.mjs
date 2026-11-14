import assert from 'node:assert/strict'
import path from 'node:path'
import ts from 'typescript'
import { createActivityTestCompilerHost } from './typecheck-activity-tests.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const config = path.join(root, 'apps/desktop/tsconfig.test.json')
const raw = ts.readConfigFile(config, ts.sys.readFile)
assert.equal(raw.error, undefined)
const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(config), {}, config)
assert.deepEqual(parsed.errors, [])
const roots = ['agent-locations.test.tsx', 'quick-switch.test.ts', 'quick-switch-demand.test.tsx'].map(file => path.join(root, 'apps/desktop/test', file))
for (const file of roots) assert.ok(ts.sys.fileExists(file), 'Actual location consumer test is required')
roots.push(...parsed.fileNames.filter(file => /\.d\.[cm]?ts$/u.test(file)))
const options = { ...parsed.options, noEmit: true, incremental: false }
const { host, resolutions, manifests } = createActivityTestCompilerHost(root, options)
const program = ts.createProgram(roots, options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n'
}))
console.log(JSON.stringify({ testRoots: 3, sourceFiles: program.getSourceFiles().length, firstPartyExports: resolutions.size, manifests: manifests.size, diagnostics: diagnostics.length }))
if (diagnostics.length) process.exitCode = 1
