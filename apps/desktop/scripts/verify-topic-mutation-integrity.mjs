import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { repository, workspaceSources } from './fixtures/topic-promotion/source-build.mjs'
import { buildWorkspaceMoveHelper } from '../../host/scripts/build-workspace-move-helper.mjs'
const { build } = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('esbuild')
const output = join(repository, '.tmp/topic-mutation-integrity/' + Date.now())
await mkdir(output, { recursive: true })
await mkdir(join(output, 'node_modules'))
for (const name of await readdir(join(repository, 'packages/core/node_modules'))) {
  if (name.startsWith('.')) continue
  if (name.startsWith('@')) {
    await mkdir(join(output, 'node_modules', name))
    for (const child of await readdir(join(repository, 'packages/core/node_modules', name)))
      await symlink(join(repository, 'packages/core/node_modules', name, child), join(output, 'node_modules', name, child), 'dir')
  } else await symlink(join(repository, 'packages/core/node_modules', name), join(output, 'node_modules', name), 'dir')
}
// Core's endpoint worker resolves its original sibling filename at runtime.
await mkdir(join(output, 'node_modules/@agentmux/core/dist'), { recursive: true })
await copyFile(join(repository, 'packages/core/package.json'), join(output, 'node_modules/@agentmux/core/package.json'))
const sources = new Map(), results = []
async function bundle(entry, outfile, mutation) {
  const built = await build({ entryPoints: [join(repository, entry)], outfile: outfile + '.bundle.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24',
    plugins: [workspaceSources(mutation)], metafile: true, logLevel: 'warning',
    banner: { js: "import { createRequire as __integrityCreateRequire } from 'node:module'; const require = __integrityCreateRequire(import.meta.url);" } })
  // Match the shipped CLI wrapper: imports must not make a bundled Provider runner its entrypoint.
  await writeFile(outfile, 'await import(' + JSON.stringify('./' + basename(outfile) + '.bundle.mjs') + ')\n')
  for (const file of Object.keys(built.metafile.inputs)) if (!file.includes('node_modules')) sources.set(file, createHash('sha256').update(await readFile(join(repository, file))).digest('hex'))
}
const helper = (await buildWorkspaceMoveHelper()).output
assert.ok(helper, 'This private Host fixture needs the original workspace file helper')
const cli = join(output, 'cli.mjs'), scenario = join(output, 'scenario.mjs')
await bundle('packages/core/src/control-endpoint-listener-worker.ts', join(output, 'node_modules/@agentmux/core/dist/control-endpoint-listener-worker.js'))
await bundle('packages/core/src/agentmux.ts', cli)
await bundle('apps/desktop/scripts/fixtures/topic-mutation-integrity/scenario.ts', scenario)
const mutants = [null,
  { name: 'classification-identity', path: 'apps/host/src/topic-spatial-owner.ts',
    before: '    assertKnowledgeTopicIdentity(graph, this.ports.workspace(), topic)\n    const categoryIds',
    after: '    // mutation: classification skips original identity\n    const categoryIds', expected: /classification|TOPIC_TARGET_IS_MOTE|0 !== 1/u },
  { name: 'literal-category-title', path: 'apps/host/src/topic-knowledge.ts',
    before: 'content.replace(/^#\\s+.+$/mu, () => `# ${(p.title as string).trim()}`)',
    after: 'content.replace(/^#\\s+.+$/mu, `# ${(p.title as string).trim()}`)', expected: /literal category title/u }
]
for (const mutant of mutants) {
  const name = mutant?.name ?? 'baseline', host = join(output, name + '.mjs'), data = await realpath(await mkdtemp(join(tmpdir(), 'amx-topic-integrity-')))
  await bundle('apps/desktop/scripts/fixtures/topic-promotion/host.ts', host, mutant)
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', scenario, data, host, cli, helper], { cwd: repository, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; process.kill(-child.pid, 'SIGKILL') }, 60_000)
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) }).finally(() => clearTimeout(timer))
  await writeFile(join(output, name + '.log'), stdout + stderr)
  if (!mutant && code === 0) await copyFile(join(data, 'result.json'), join(output, 'baseline.json'))
  await rm(data, { recursive: true, force: true })
  assert.equal(timedOut, false, 'A fixture timeout is not a behavioral mutation failure')
  if (!mutant) assert.equal(code, 0, stdout + stderr)
  else {
    assert.equal(mutant.loaded, true, 'Production mutation was not loaded')
    assert.notEqual(code, 0, 'Production mutation survived: ' + name)
    assert.match(stderr, /AssertionError \[ERR_ASSERTION\]/u)
    assert.match(stderr, mutant.expected)
    assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|Host startup exit|Host ready missing/u)
  }
  results.push({ name, code, log: relative(repository, join(output, name + '.log')), ...(mutant ? { mutation: { path: mutant.path, before: mutant.before, after: mutant.after } } : {}) })
  process.stdout.write(name + ': ' + code + '\n')
}
for (const file of ['apps/desktop/scripts/verify-topic-mutation-integrity.mjs', 'apps/desktop/scripts/fixtures/topic-promotion/source-build.mjs', 'apps/host/native/workspace-move.c'])
  sources.set(file, createHash('sha256').update(await readFile(join(repository, file))).digest('hex'))
assert.ok(sources.size > 0)
for (const file of ['apps/host/src/content-owner.ts', 'apps/host/src/topic-spatial-owner.ts', 'apps/host/src/topic-knowledge.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/agentmux-cli-commands.ts'])
  assert.ok(sources.has(file), 'The real public Topic consumer was not loaded: ' + file)
const receipt = { passed: true, evidenceDirectory: relative(repository, output), results, baseline: JSON.parse(await readFile(join(output, 'baseline.json'), 'utf8')), sourceDigests: Object.fromEntries([...sources].sort(([a], [b]) => a.localeCompare(b))) }
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
process.stdout.write('receipt: ' + relative(repository, join(output, 'receipt.json')) + '\n')
