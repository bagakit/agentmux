import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const output = join(root, 'docs/reviews/evidence/editor-inline-html')
const sha = value => createHash('sha256').update(value).digest('hex')
const paneTest = 'apps/desktop/test/file-preview-pane.test.tsx'
const component = 'apps/desktop/src/renderer/src/components/HtmlFilePreview.tsx'
const router = 'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx'
const cases = [
  ['current-buffer', router, 'path={surface.path} content={doc.content} />', 'path={surface.path} content="" />', paneTest, 'previews the current'],
  ['opaque-page', component, 'sandbox="allow-scripts"', 'sandbox="allow-scripts allow-same-origin"', paneTest, 'previews the current'],
  ['late-resource-release', component, 'if (cancelled || !owner.valid || resourceKey(workspaceId) !== owner.resource)', 'if (false)', paneTest, 'releases a late HTML response'],
  ['html-public-mode', 'apps/desktop/src/shared/workspace-file-format.ts', "html: 'html', htm: 'html',", "html: null, htm: null,", 'apps/desktop/test/workface-file-view-control.test.tsx', 'reports page.html reader support'],
  ['asset-resource-identity', 'apps/desktop/src/main/html-file-previews.ts', 'return !this.disposed && this.previews.get(id) === preview && this.workspaceMatches(preview)', 'return !this.disposed && this.previews.get(id) === preview', 'apps/desktop/test/html-file-preview.test.ts', 'does not leak late asset bytes'],
  ['main-frame-admission', 'apps/desktop/src/main/ipc.ts', "if (event.senderFrame !== args.window.webContents.mainFrame) throw new Error('HTML preview requires the original application frame.')\n    return await htmlPreviews.open", 'return await htmlPreviews.open', 'apps/desktop/test/html-preview-ipc.test.ts', 'refuses an untrusted sender or subframe']
]
function run(files, pattern) {
  const args = ['run', ...files, '--maxWorkers=1', ...(pattern ? ['-t', pattern] : [])]
  const result = spawnSync(join(root, 'node_modules/.bin/vitest'), args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  return { exitCode: result.status, raw: result.stdout + result.stderr, command: ['vitest', ...args] }
}
await mkdir(output, { recursive: true })
const records = [], sources = {}
for (const [name, file, originalBlock, brokenBlock, test, pattern] of cases) {
  const target = join(root, file), original = await readFile(target), text = original.toString('utf8')
  assert.equal(text.split(originalBlock).length, 2, 'Unique production mutation: ' + name)
  const mutant = text.replace(originalBlock, brokenBlock)
  try {
    await writeFile(target, mutant)
    const red = run([test], pattern), log = `mutation-${name}.log`
    await writeFile(join(output, log), red.raw)
    assert.notEqual(red.exitCode, 0, 'Mutation survived: ' + name)
    assert.ok(red.raw.includes('AssertionError'), 'An actual assertion must fail: ' + name + '\n' + red.raw)
    records.push({ name, file, originalBlock, brokenBlock, originalSha256: sha(original), mutantSha256: sha(mutant),
      command: red.command, red: { exitCode: red.exitCode, assertionError: true, log, sha256: sha(red.raw) } })
    console.log(name + ' ASSERTION_RED')
  } finally {
    // No other author owns these production slices during this bounded experiment.
    assert.equal(sha(await readFile(target)), sha(mutant), 'Unexpected concurrent source write; refusing to overwrite: ' + file)
    await writeFile(target, original)
    assert.equal(sha(await readFile(target)), sha(original))
    sources[file] = sha(original)
  }
}
const unit = run([paneTest, 'apps/desktop/test/html-file-preview.test.ts', 'apps/desktop/test/html-preview-ipc.test.ts'])
const cli = run(['apps/desktop/test/workface-file-view-control.test.tsx'], 'File Region modes through')
const green = { exitCode: unit.exitCode || cli.exitCode, raw: unit.raw + '\n' + cli.raw, command: [unit.command, cli.command] }
const log = 'mutation-restored-green.log'
await writeFile(join(output, log), green.raw)
assert.equal(green.exitCode, 0, green.raw)
const receipt = { passed: true, sources, mutations: records, restoredGreen: { exitCode: green.exitCode, command: green.command, log, sha256: sha(green.raw) } }
await writeFile(join(output, 'mutation-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log('RESTORED_GREEN')
