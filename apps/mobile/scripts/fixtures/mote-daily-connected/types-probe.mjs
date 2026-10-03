import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../../../..')
const index = process.argv.indexOf('--evidence-dir'), output = resolve(root, index < 0 ? '.tmp/mote-daily-connected/types' : process.argv[index + 1])
const baseIndex = process.argv.indexOf('--baseline-main'), baselineMain = baseIndex < 0 ? null : process.argv[baseIndex + 1]
const nativeOwner = process.argv.includes('--native-owner')
const original = file => {
  if (!baselineMain || file.includes('node_modules') || !file.startsWith(root + '/')) return undefined
  try { return execFileSync('git', ['show', baselineMain + ':' + relative(root, file)], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return undefined }
}
const config = ts.readConfigFile(resolve(root, 'apps/mobile/tsconfig.json'), ts.sys.readFile)
assert.equal(config.error, undefined)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, 'apps/mobile'))
const paths = {}
for (const name of ['core', 'demand', 'layout', 'relay', 'client-ui']) {
  const directory = resolve(root, 'packages', name), manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  assert.ok(Object.keys(manifest.exports).length)
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const source = typeof target === 'string' ? target : target.browser ?? target.import
    const mapped = source.startsWith('./src/') ? source : source.replace('./dist/', name === 'core' || name === 'relay' ? './src/' : './').replace(/\.js$/, '.ts')
    const destination = resolve(directory, mapped)
    if (!subpath.includes('*')) assert.ok(existsSync(destination), `Original Source export is missing: ${name}${subpath}`)
    paths[`@agentmux/${name}${subpath === '.' ? '' : subpath.slice(1)}`] = [destination]
  }
}
paths['base64-js'] = [resolve(root, 'node_modules/.pnpm/base64-js@1.5.1/node_modules/base64-js/index.d.ts')]
paths.tweetnacl = [resolve(root, 'node_modules/.pnpm/tweetnacl@1.0.3/node_modules/tweetnacl/nacl.d.ts')]
for (const name of ['base64-js', 'tweetnacl']) assert.ok(existsSync(paths[name][0]), `Original installed dependency is missing: ${name}`)
const roots = [...parsed.fileNames, resolve(root, 'apps/mobile/node_modules/vite/client.d.ts'), resolve(root, 'apps/mobile/test/connected-goal.test.tsx'), resolve(root, 'apps/mobile/test/device-workface.test.tsx'),
  ...(nativeOwner ? [resolve(root, 'apps/desktop/scripts/fixtures/mote-daily-device/runtime-owner.ts'), resolve(root, 'apps/desktop/src/renderer/src/global.d.ts')] : [])]
  .filter(file => !baselineMain || file.includes('node_modules') || original(file) !== undefined)
const options = { ...parsed.options, types: parsed.options.types.filter(name => name !== 'vite/client'), baseUrl: root, paths,
  ...(nativeOwner ? { noEmit: true, allowImportingTsExtensions: true } : {}) }
const host = ts.createCompilerHost(options), read = host.readFile
if (baselineMain) {
  host.readFile = file => original(file) ?? read(file)
  host.getSourceFile = (file, languageVersion) => {
    const bytes = host.readFile(file)
    return bytes === undefined ? undefined : ts.createSourceFile(file, bytes, languageVersion, true)
  }
}
const program = ts.createProgram(roots, options, host)
const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ({ code: diagnostic.code, file: diagnostic.file ? relative(root, diagnostic.file.fileName) : null,
  line: diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : null,
  message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }))
const source = Object.fromEntries(program.getSourceFiles().filter(file => !file.fileName.includes('node_modules') && file.fileName.startsWith(root + '/'))
  .map(file => [relative(root, file.fileName), createHash('sha256').update(file.text).digest('hex')]))
assert.ok(Object.keys(source).length)
const dependencies = Object.fromEntries(program.getSourceFiles().filter(file => file.fileName.includes('node_modules'))
  .map(file => [relative(root, file.fileName), createHash('sha256').update(readFileSync(file.fileName)).digest('hex')]))
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'receipt.json'), JSON.stringify({ passed: diagnostics.length === 0, baselineMain, roots: roots.map(file => relative(root, file)), source, dependencies, diagnostics, diagnosticCount: diagnostics.length }, null, 2) + '\n')
console.log(JSON.stringify({ passed: diagnostics.length === 0, diagnosticCount: diagnostics.length, sourceCount: Object.keys(source).length, receipt: relative(root, resolve(output, 'receipt.json')) }))
process.exitCode = diagnostics.length ? 1 : 0
