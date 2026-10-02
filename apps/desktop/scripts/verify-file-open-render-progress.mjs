import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
await mkdir(join(root, '.tmp'), { recursive: true })
const proof = await mkdtemp(join(root, '.tmp/file-open-render-progress-'))
const sources = [
  'apps/desktop/src/renderer/src/components/FileExplorer.tsx',
  'apps/desktop/src/renderer/src/components/file-tree/FileTreeContextMenu.tsx',
  'apps/desktop/src/renderer/src/lib/file-explorer-move.ts',
]
const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [
  path, createHash('sha256').update(await readFile(join(root, path))).digest('hex'),
])))
const explorer = await readFile(join(root, sources[0]), 'utf8')
const menu = await readFile(join(root, sources[1]), 'utf8')
assert.match(explorer, /createFileExplorerMoveIndex\(/, 'The real FileExplorer must consume the tree index')
assert.match(explorer, /getMoveTargets=\{getMoveTargets\}/, 'The real row must pass the lazy menu caller')
assert.match(menu, /ContextMenu\.Root onOpenChange=/, 'The installed menu must admit targets at its actual open boundary')
const config = join(proof, 'vitest.loaded.mts')
await writeFile(config, `import { mergeConfig } from 'vitest/config'
import base from ${JSON.stringify(join(root, 'vitest.config.ts'))}
const mode = process.env.FILE_OPEN_PROGRESS_MUTANT
export default mergeConfig(base, { plugins: [{
  name: 'file-open-progress-loaded-mutation', enforce: 'pre',
  transform(code, id) {
    const path = id.split('?')[0]
    const anchor = mode === 'eager'
      ? 'open ? getMoveTargets() : EMPTY_MOVE_TARGETS'
      : 'index.paths.has(destinationPath)'
    const selected = mode === 'eager'
      ? path.endsWith('/components/file-tree/FileTreeContextMenu.tsx')
      : path.endsWith('/lib/file-explorer-move.ts')
    if (!selected) return null
    if (!code.includes(anchor)) throw Error('Loaded mutation anchor missing: ' + mode)
    return code.replace(anchor, mode === 'eager'
      ? 'getMoveTargets()'
      : '[...index.paths].some(path => path === destinationPath)')
  }
}] })
`)
const receipt = { sourceHashes: await sourceHashes(), outsideCallers: sources.slice(0, 2), phases: [] }
for (const mode of ['green', 'eager', 'scan', 'restored']) {
  const output = join(proof, mode + '.json'), logs = []
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(join(root, 'node_modules/.bin/vitest'), [
      'run', '--config', ['eager', 'scan'].includes(mode) ? config : './vitest.config.ts', '--root', '.',
      'apps/desktop/test/file-explorer-foundations.test.ts',
      'apps/desktop/test/file-explorer-open-as-project.integration.test.tsx',
      'apps/desktop/test/workface-file-open-control.test.tsx',
      '-t', 'file explorer move interaction|FileExplorer directory context menu|deferred.*read',
      '--reporter=json', '--outputFile=' + output,
    ], { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'warn', FILE_OPEN_PROGRESS_MUTANT: mode } })
    child.stdout.on('data', data => logs.push(data))
    child.stderr.on('data', data => logs.push(data))
    child.on('error', reject)
    child.on('exit', resolveExit)
  })
  await writeFile(join(proof, mode + '.log'), Buffer.concat(logs))
  const result = JSON.parse(await readFile(output, 'utf8'))
  const failures = result.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  receipt.phases.push({ mode, exitCode, passed: result.numPassedTests, failed: result.numFailedTests,
    assertions: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
  assert.deepEqual(await sourceHashes(), receipt.sourceHashes, 'Loaded mutations must leave Source intact')
  if (['eager', 'scan'].includes(mode)) {
    assert.notEqual(exitCode, 0)
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Mutation must fail a behavior assertion')
  } else {
    assert.equal(exitCode, 0)
    assert.equal(result.numPassedTests, 15, 'Move consumers and both deferred reads must actually run')
  }
}
await writeFile(join(proof, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ proof, phases: receipt.phases.map(({ assertions, ...phase }) => phase) }))
