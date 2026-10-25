import { createRequire } from 'node:module'
const { build } = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('esbuild')
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, symlink, readdir, mkdtemp, realpath, copyFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { repository, workspaceSources } from './fixtures/topic-promotion/source-build.mjs'
import { buildWorkspaceMoveHelper } from '../../host/scripts/build-workspace-move-helper.mjs'
const output = join(repository, '.tmp/topic-promotion/owner-' + Date.now())
await mkdir(output, { recursive: true })
await mkdir(join(output, 'node_modules'))
for (const name of await readdir(join(repository, 'packages/core/node_modules'))) {
 if (name.startsWith('.')) continue
 if (name.startsWith('@')) {
  await mkdir(join(output, 'node_modules', name))
  for (const child of await readdir(join(repository, 'packages/core/node_modules', name))) await symlink(join(repository, 'packages/core/node_modules', name, child), join(output, 'node_modules', name, child), 'dir')
 } else await symlink(join(repository, 'packages/core/node_modules', name), join(output, 'node_modules', name), 'dir')
}
await mkdir(join(output, 'node_modules/@agentmux/core/dist'), { recursive: true })
await copyFile(join(repository, 'packages/core/package.json'), join(output, 'node_modules/@agentmux/core/package.json'))
const helper = (await buildWorkspaceMoveHelper()).output
const fixture = join(repository, 'apps/desktop/scripts/fixtures/topic-promotion')
const results = [], sources = new Set()
async function bundle(entry, outfile, mutation) {
 const result = await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24',
  plugins: [workspaceSources(mutation)], metafile: true, logLevel: 'warning',
  banner: { js: "import { createRequire as __promotionCreateRequire } from 'node:module'; const require = __promotionCreateRequire(import.meta.url);" } })
 for (const path of Object.keys(result.metafile.inputs)) if (!path.includes('node_modules')) sources.add(path)
}
await bundle(join(repository, 'packages/core/src/control-endpoint-listener-worker.ts'), join(output, 'node_modules/@agentmux/core/dist/control-endpoint-listener-worker.js'))
const cli = join(output, 'cli.mjs')
await bundle(join(repository, 'packages/core/src/agentmux.ts'), cli)
const mutants = [null,
 { name: 'missing-mote-binding', path: 'apps/host/src/topic-spatial-owner.ts',
  before: "if (!graph.bindings.some(binding => binding.spaceId === spaceId && binding.zoneId === zoneId)) graph.bindings.push({ spaceId, zoneId })",
  after: "/* mutation: omit actual Mote binding */" },
 { name: 'knowledge-continuity', path: 'apps/host/src/topic-knowledge.ts',
  before: "if (original.contentKind !== 'topic' && original.contentKind !== 'mote') throw new AgentMuxError('The original Topic kind",
  after: "if (original.contentKind !== 'topic') throw new AgentMuxError('The original Topic kind" }
]
for (const mutant of mutants) {
 const name = mutant?.name ?? 'baseline', host = join(output, name + '.mjs'), data = await realpath(await mkdtemp('/tmp/amx-promote-'))
 await bundle(join(fixture, 'host.ts'), host, mutant)
 const child = spawn(process.execPath, [join(fixture, 'owner-scenario.mjs'), data, host, cli, helper], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
 let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
 const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) })
 await writeFile(join(output, name + '.log'), stdout + stderr)
 if (code === 0) { await mkdir(join(output, name)); await copyFile(join(data, 'result.json'), join(output, name, 'result.json')) }
 await rm(data, { recursive: true, force: true })
 results.push({ name, code, log: relative(repository, join(output, name + '.log')), ...(mutant ? { mutation: mutant } : {}) })
 if (!mutant) assert.equal(code, 0, stderr)
 else {
  assert.notEqual(code, 0, 'Production mutation survived: ' + name)
  assert(mutant.loaded, 'Mutation source was not loaded')
  assert.match(stderr, /AssertionError \[ERR_ASSERTION\]/u)
  assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|Host startup exit/u)
  assert.match(stderr, mutant.name === 'missing-mote-binding' ? /'partial'[\s\S]*'complete'/u : /TOPIC_IDENTITY_UNCONFIRMED/u)
 }
 process.stdout.write(name + ': ' + code + '\n')
}
const evidenceFiles = ['apps/desktop/scripts/verify-topic-promotion-owner.mjs', ...['host.ts','source-build.mjs','owner-scenario.mjs'].map(name => 'apps/desktop/scripts/fixtures/topic-promotion/' + name),
 'apps/host/native/workspace-move.c', 'apps/host/src/mote-directory-maintenance.mjs', 'apps/host/src/mote-directory-maintenance.d.mts', 'apps/desktop/src/main/scratch-directory-maintenance.mjs', 'apps/desktop/src/main/scratch-directory-maintenance.d.mts', 'packages/core/guides/modules/topic.md']
for (const file of evidenceFiles) sources.add(file)
const sourceDigests = {}
for (const path of [...sources].sort()) sourceDigests[path] = createHash('sha256').update(await readFile(join(repository, path))).digest('hex')
const baseline = JSON.parse(await readFile(join(output, 'baseline/result.json'), 'utf8'))
const receipt = { passed: true, evidenceDirectory: relative(repository, output), results, baseline, sourceDigests }
await writeFile(join(repository, '.tmp/topic-promotion/backend-receipt.json'), JSON.stringify(receipt, null, 2))
process.stdout.write('receipt: .tmp/topic-promotion/backend-receipt.json\n')
