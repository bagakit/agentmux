import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { bundlePrivateNodeSource } from '../../../../packages/core/test/helpers/private-node-source-bundle.mjs'

const root = process.cwd(), [path, privateRoot] = process.argv.slice(2), file = resolve(privateRoot, 'original-user-reader.mjs')
const sourceExport = specifier => {
  if (!specifier.startsWith('@agentmux/')) return null
  const [scope, name, ...tail] = specifier.split('/'), directory = resolve(root, name === 'host' ? 'apps' : 'packages', name)
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')), key = tail.length ? './' + tail.join('/') : '.'
  const value = manifest.exports[key] ?? manifest.exports['./*']
  if (!value) return null
  const target = typeof value === 'string' ? value : value.import
  const original = resolve(directory, target.replace('*', tail.join('/')).replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  if (existsSync(original)) return original
  return null
}
await bundlePrivateNodeSource({ root, entry: 'apps/desktop/test/fixtures/question-owner-reopen-entry.ts', file, sourceExport,
  instrument(source, path) { return path === 'apps/desktop/src/main/workbench-user-state.ts' ? 'Reflect.set(globalThis,"__questionReopenSource",true);\n' + source : source } })
const reopened = JSON.parse(execFileSync(process.execPath, [file, path], { env: process.env, encoding: 'utf8', maxBuffer: 1024 * 1024 }))
assert.equal(reopened.ownerSourceEvaluated, true)
const provenance = JSON.parse(readFileSync(file + '.provenance.json', 'utf8'))
reopened.owningSource = provenance.sources?.find(value => value.path === 'apps/desktop/src/main/workbench-user-state.ts') ?? provenance
console.log(JSON.stringify(reopened))
