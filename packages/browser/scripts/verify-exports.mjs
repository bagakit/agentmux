import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const directory = resolve(import.meta.dirname, '..')
const repo = resolve(directory, '../..')
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
const privateEntry = '@agentmux/browser/browser-page-dispatch'
const checkPrivateEntry = `
  import assert from 'node:assert/strict'
  assert.throws(() => import.meta.resolve(${JSON.stringify(privateEntry)}),
    { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }, 'Browser internals must stay private')
`
execFileSync(process.execPath, ['--input-type=module', '--eval', checkPrivateEntry], { cwd: directory })

const entries = new Map([
  ['@agentmux/browser', 'serveStandaloneBrowser'],
  ['@agentmux/browser/model', 'narrowBrowserOperation'],
  ['@agentmux/browser/page', 'createBrowserPageDispatch'],
  ['@agentmux/browser/operations', 'BrowserOperationJournal']
])
for (const [entry, member] of entries) {
  assert.equal(typeof (await import(entry))[member], 'function', `The compiled entry exposes its real member: ${entry}`)
}

const files = execFileSync('rg', ['--files-with-matches', '--null', '--fixed-strings', '@agentmux/browser',
  '--glob', '*.{js,mjs,cjs,ts,mts,cts,tsx}', 'apps', 'packages', 'scripts', 'test'], { cwd: repo, encoding: 'utf8' })
  .split('\0').filter(file => file && file !== 'packages/browser/scripts/verify-exports.mjs')
let consumers = 0
for (const file of files) {
  const code = await readFile(join(repo, file), 'utf8')
  for (const match of code.matchAll(/['"](@agentmux\/browser(?:\/[\w./-]+)?)['"]/gu)) {
    assert.ok(entries.has(match[1]), `Use a declared Browser entry in ${file}: ${match[1]}`)
    consumers++
  }
}
assert.ok(consumers > 0, 'Verify the actual repository consumers')

let wildcardRejected = false
if (process.argv.includes('--mutations')) {
  const mutated = await mkdtemp(join(tmpdir(), 'amux-browser-exports-'))
  try {
    manifest.exports['./*'] = { import: './dist/*.js' }
    await writeFile(join(mutated, 'package.json'), JSON.stringify(manifest))
    const exposedInternals = spawnSync(process.execPath, ['--input-type=module', '--eval', checkPrivateEntry], {
      cwd: mutated, encoding: 'utf8'
    })
    assert.ifError(exposedInternals.error)
    assert.equal(exposedInternals.status, 1)
    assert.match(exposedInternals.stderr, /Missing expected exception.*Browser internals must stay private/u)
    wildcardRejected = true
  } finally {
    await rm(mutated, { recursive: true })
  }
}
const receipt = { passed: true, entries: [...entries.keys()], consumers, wildcardRejected }
const out = join(repo, '.local/browser-boundaries/exports.json')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
