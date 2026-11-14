import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.tmp/promotion-menu-refinement')
const files = [
 'apps/desktop/src/renderer/src/components/AgentMenuContent.tsx',
 'apps/desktop/src/renderer/src/components/TopicContextMenu.tsx',
 'apps/desktop/src/renderer/src/components/settings/TopicDirectorySettingsPane.tsx',
 'packages/client-ui/src/theme/icon-authored.ts', 'packages/client-ui/src/theme/icon-catalog.ts',
 'apps/desktop/test/agent-promotion-ui.test.tsx', 'apps/desktop/test/promotion-menu.config.mts',
 'apps/desktop/scripts/fixtures/agent-promotion/entry.tsx', 'apps/desktop/scripts/fixtures/agent-promotion/main.cjs'
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
async function run(args, env = {}) {
 const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
 let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b)
 const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) })
 return { code, stdout, stderr }
}
await mkdir(evidence, { recursive: true })
if (process.argv.includes('--prepare')) {
 const result = await run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/promotion-menu.config.mts'])
 await writeFile(join(evidence, 'baseline.log'), result.stdout + result.stderr)
 assert.equal(result.code, 0, result.stdout + result.stderr); assert.match(result.stdout, /Tests\s+9 passed/u)
 const results = []
 for (const mutation of ['language', 'topic-icon', 'shared-drawing']) {
  const changed = await run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/promotion-menu.config.mts'], { PROMOTION_MENU_MUTANT: mutation, NO_COLOR: '1' })
  const log = changed.stdout + changed.stderr
  await writeFile(join(evidence, mutation + '.log'), log)
  assert.notEqual(changed.code, 0, 'Actual implementation mutation survived: ' + mutation)
  assert.ok(log.includes('PROMOTION_MENU_MUTANT_LOADED ' + mutation)); assert.match(log, /AssertionError/u)
  assert.doesNotMatch(log, /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|No test files/u)
  results.push({ mutation, code: changed.code }); console.log(mutation + ': assertion red')
 }
 const capture = await run(['apps/desktop/scripts/fixtures/agent-promotion/capture.mjs'])
 await writeFile(join(evidence, 'capture.log'), capture.stdout + capture.stderr)
 assert.equal(capture.code, 0, capture.stdout + capture.stderr)
 const latest = await json(join(root, '.tmp/agent-mote-promotion/latest-visual.json'))
 const visual = await json(join(root, latest.evidence, 'receipt.json'))
 assert.equal(visual.passed, true); assert.equal(visual.actual.passed, true); assert.equal(visual.frames.length, 16)
 const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
 await writeFile(join(evidence, 'prepared.json'), JSON.stringify({ passed: true, results, sources, visual: latest.evidence }, null, 2))
 console.log('Prepared actual menu/settings candidate: ' + latest.evidence)
} else {
 const prepared = await json(join(evidence, 'prepared.json')); assert.equal(prepared.passed, true)
 assert.equal(prepared.results.length, 3); for (const result of prepared.results) assert.notEqual(result.code, 0)
 assert.ok(Object.keys(prepared.sources).length > 0)
 for (const [file, digest] of Object.entries(prepared.sources)) assert.equal(hash(await readFile(join(root, file))), digest, 'Changed accepted source: ' + file)
 const visual = await json(join(root, prepared.visual, 'receipt.json'))
 assert.equal(visual.passed, true); assert.equal(visual.actual.passed, true); assert.equal(visual.frames.length, 16)
 for (const frame of visual.frames) assert.equal(hash(await readFile(join(root, prepared.visual, frame.file))), frame.sha256)
 const review = await readFile(join(evidence, 'visual-review.md'), 'utf8')
 assert.match(review, /(?:Decision|结论):\s*(?:approved|可交付)/u); assert.ok(review.includes(prepared.visual))
 const design = await json(join(evidence, 'icon-discussion.json')); assert.equal(design.participant, 'UtScXtMzkxky'); assert.ok(design.replyMessageId)
 const receipt = { ...prepared, discussion: design, independentlyReviewed: true, boundary: visual.boundary }
 await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
 console.log('Promotion menus: 9 behavior tests, 3 actual implementation mutations, original icon discussion and 16 captured Renderer frames with independent review of the affected menus and settings match the current candidate.')
}
