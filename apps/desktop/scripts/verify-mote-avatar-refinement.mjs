import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
const repository = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.deepEqual(args.slice(0, 1), ['--slice']); assert.ok(['editor', 'motion'].includes(args[1])); assert.equal(args.length, 2)
const slice = args[1], evidence = join(repository, '.tmp/mote-avatar-refinement', slice + '-' + Date.now())
await mkdir(evidence, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const product = ['components/SpaceIconPicker.tsx','components/MoteFaceEditor.tsx','components/MoteFace.tsx','components/MoteIdentityMotion.tsx','components/SpaceObjectIcon.tsx','components/settings/LiquidSelectionSurface.tsx','lib/mote-face-motion.ts','lib/mote-expression.ts','lib/session-state.ts','lib/session-events.ts','store.ts','styles/space-object-appearance.css'].map(file => 'apps/desktop/src/renderer/src/' + file)
product.push('apps/desktop/src/shared/mote-avatars.ts','apps/desktop/scripts/fixtures/mote-navigation-footer/paperdoll-entry.tsx')
const files = await Promise.all(product.map(async path => ({ path, sha256: hash(await readFile(join(repository, path))) })))
const candidate = join(evidence, 'candidate.json'); await writeFile(candidate, JSON.stringify({ schema:'agentmux.mote-avatar-refinement-candidate.v1', files }, null, 2))
const receipt = { schema:'agentmux.mote-avatar-refinement.v1', slice, passed:false, files, commands:[], userAppOrRunTouched:false, frontend:'AgentMux Browser HTTP preview; native restart probe remains background-only', visualReview:'pending independent Agent review' }
async function run(name, argv, env = process.env) {
  const child = spawn(process.execPath, argv, { cwd:repository, env, stdio:['ignore','pipe','pipe'] }); let output=''
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk)
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  await writeFile(join(evidence, name + '.log'), output); receipt.commands.push({ name, argv, exit, sha256:hash(output) }); assert.equal(exit,0,output.slice(-2500)); return output
}
try {
  await run('owning', ['node_modules/vitest/vitest.mjs','run','--config','apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'test/mote-paperdoll-avatar.test.tsx','test/mote-avatar-identity.test.tsx','test/mote-avatar-motion.test.tsx','test/mote-paperdoll-state.test.tsx'])
  const mutations = slice === 'editor' ? ['face-is-not-first','save-invisible-alternative','source-switch-publishes-draft','source-switch-resets-crop','cancel-writes-face','avatar-liquid-ignores-x'] : ['face-gaze-is-disconnected','saved-face-never-joins-motion','sessionless-face-subscribes-to-store','hidden-face-does-work','reduced-face-does-work','offscreen-face-does-work']
  await run('mutations', ['apps/desktop/scripts/verify-mote-paperdoll-mutations.mjs', ...mutations])
  const actual = await run('actual-renderer', ['apps/desktop/scripts/verify-mote-navigation-footer.mjs','--capture','mote-paperdoll','--candidate',candidate], { ...process.env, AGENTMUX_AVATAR_REFINEMENT:'1' })
  const line = actual.trim().split('\n').findLast(value => value.startsWith('{') && value.includes('receipt'))
  if (line) receipt.actual = JSON.parse(line)
  for (const file of files) assert.equal(hash(await readFile(join(repository,file.path))),file.sha256,'Candidate preserved throughout proof')
  receipt.passed = true
} catch(cause) { receipt.failure = { name:cause.name, message:cause.message, stack:cause.stack } }
await writeFile(join(evidence, 'receipt.json'),JSON.stringify(receipt,null,2))
console.log(JSON.stringify({ passed:receipt.passed, receipt:join(evidence,'receipt.json'), actual:receipt.actual, failure:receipt.failure?.message }))
if(!receipt.passed)process.exitCode=1
