import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join, relative } from 'node:path'
const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/mote-paperdoll-mutations', String(Date.now()))
await mkdir(evidence, { recursive: true })
const clone = await mkdtemp(join(repository, '.tmp/mote-paperdoll-mutation-source-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { schema: 'agentmux.mote-paperdoll-source-mutations.v1', passed: false, userAppOrRunTouched: false, cases: [], callers: {}, files: {}, cleanup: false }
async function run(log, test, pattern) {
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', test, '--maxWorkers=1', '--reporter=verbose', '--testNamePattern', pattern]
  const child = spawn(process.execPath, args, { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  await writeFile(join(evidence, log), output)
  return { exit, output, log, sha256: hash(output), command: [process.execPath, ...args] }
}
async function files(directory) {
  const rows = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const file = join(directory, entry.name)
    if (entry.isDirectory()) rows.push(...await files(file))
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) rows.push(file)
  }
  return rows
}
const avatar = 'test/mote-paperdoll-avatar.test.tsx', state = 'test/mote-paperdoll-state.test.tsx', motion = 'test/mote-avatar-motion.test.tsx'
const variants = [
  ['source-switch-resets-crop', 'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx', 'test/mote-avatar-identity.test.tsx', 'source pages retain', s => s.replace('MoteAvatarCrop key={preview.revision}', "MoteAvatarCrop key={editingFace ? 'face' : preview.revision}")],
  ['face-is-not-first', 'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx', avatar, 'opens Make a face first', s => s.replace('setEditingFace(Boolean(target?.avatarTarget))', 'setEditingFace(false)')],
  ['save-invisible-alternative', 'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx', avatar, 'opens Make a face first', s => s.replace('let choice = draft', 'let choice = alternativeDraft')],
  ['source-switch-publishes-draft', 'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx', avatar, 'opens Make a face first', s => s.replace('setDraft(face ? faceDraft : alternativeDraft)', 'setDraft(face ? faceDraft : alternativeDraft); if(target) void useAppStore.getState().setSpaceObjectIcon(target.key, face ? faceDraft : alternativeDraft)')],
  ['avatar-liquid-ignores-x', 'apps/desktop/src/renderer/src/components/settings/LiquidSelectionSurface.tsx', motion, 'same connected liquid', s => s.replace('const horizontal = Math.abs(next.x - from.x) > Math.abs(next.y - from.y)', 'const horizontal = false')],
  ['face-gaze-is-disconnected', 'apps/desktop/src/renderer/src/lib/mote-face-motion.ts', motion, 'connected static face rig', s => s.replace("setProperty('--mote-gaze-x'", "setProperty('--unused-gaze-x'")],
  ['saved-face-never-joins-motion', 'apps/desktop/src/renderer/src/components/MoteIdentityMotion.tsx', motion, 'a saved face joins', s => s.replace('[expression, visible, children]', '[expression, visible]')],
  ['sessionless-face-subscribes-to-store', 'apps/desktop/src/renderer/src/components/MoteIdentityMotion.tsx', motion, 'identities without a Session', s => s.replace('return !props.moteSessionId', 'return false')],
  ['hidden-face-does-work', 'apps/desktop/src/renderer/src/lib/mote-face-motion.ts', motion, 'eighty hidden faces', s => s.replace('identity.visible && identity.inView &&', '')],
  ['reduced-face-does-work', 'apps/desktop/src/renderer/src/lib/mote-face-motion.ts', motion, 'eighty hidden faces', s => s.replace('&& !reduced.matches', '')],
  ['offscreen-face-does-work', 'apps/desktop/src/renderer/src/lib/mote-face-motion.ts', motion, 'eighty hidden faces', s => s.replace('identity.inView && ', '')],
  ['confirm-before-publish', 'apps/desktop/src/renderer/src/store.ts', avatar, 'failed confirmation', s => s.replace('      writeChoice(choice(get().spaceObjectIcons))\n      await requestWorkbenchStorageFlush()', '      set(state => ({ spaceObjectIcons: choice(state.spaceObjectIcons) }))\n      writeChoice(choice(get().spaceObjectIcons))\n      await requestWorkbenchStorageFlush()')],
  ['cancel-writes-face', 'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx', avatar, 'Cancel and Escape', s => s.replace('disabled={busy} onClick={onClose}', 'disabled={busy} onClick={() => { if(target) void useAppStore.getState().setSpaceObjectIcon(target.key, draft); onClose() }}')],
  ['disconnect-real-face-consumer', 'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx', avatar, 'real primary and custom editor', s => s.replace('<MoteFace face={manualIcon} expression={expression} />', '<NotebookText size={14} />')],
  ['selected-face-loses-outline', 'apps/desktop/src/renderer/src/components/MoteFaceEditor.tsx', avatar, 'the actual face editor paints', s => s.replace("face[part] === value ? ' small-button--active' : ''", "false ? ' small-button--active' : ''")],
  ['unselected-face-checks-visible', 'apps/desktop/src/renderer/src/styles/space-object-appearance.css', avatar, 'the actual face editor paints', s => s.replace('.mote-face-editor button[aria-pressed="true"] > .mote-avatar-selection-mark { visibility: visible; }', '.mote-face-editor button > .mote-avatar-selection-mark { visibility: visible; }')],
  ['unselected-source-check-visible', 'apps/desktop/src/renderer/src/styles/space-object-appearance.css', avatar, 'the actual face editor paints', s => s.replace('.mote-avatar-source button[aria-pressed="true"] > .mote-avatar-selection-mark,', '.mote-avatar-source button > .mote-avatar-selection-mark,')],
  ['mote-save-loses-primary-action', 'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx', avatar, 'the actual face editor paints', s => s.replace("target?.avatarTarget ? 'primary-button' : 'small-button'", "target?.avatarTarget ? 'small-button' : 'small-button'")],
  ['restoring-is-sleep', 'apps/desktop/src/renderer/src/lib/mote-expression.ts', state, 'confirmed launcher sleeps', s => s.replace("availability === 'restoring' ? 'unknown'", "availability === 'restoring' ? 'sleep'")],
  ['running-is-idle', 'apps/desktop/src/renderer/src/lib/mote-expression.ts', state, 'confirmed launcher sleeps', s => s.replace("if (session.status.state === 'disconnected' || session.status.state === 'running') return 'unknown'", "if (session.status.state === 'running') return 'idle'\n  if (session.status.state === 'disconnected') return 'unknown'")],
  ['admit-old-run-tool', 'apps/desktop/src/renderer/src/lib/session-state.ts', state, 'old Run, old epoch', s => s.replace('evidence.run?.runId === session.control.run.runId', 'true')],
  ['completed-tool-keeps-moving', 'apps/desktop/src/renderer/src/lib/session-state.ts', state, 'actual applyEvent admits', s => s.replace("return mutation.status === 'complete' || mutation.status === 'failed' ? undefined : { ...retained, observedAt: evidence.observedAt }", 'return { ...retained, observedAt: evidence.observedAt }')],
  ['late-old-round-completes-current', 'apps/desktop/src/renderer/src/lib/session-state.ts', state, 'old Run, old epoch', s => s.replace('item.createdAt === retained.startedAt && ', '')],
  ['whole-own-history-subscription', 'apps/desktop/src/renderer/src/components/MoteIdentityMotion.tsx', state, 'offscreen, hidden', s => s.replace('  const expression = useAppStore(state => {', '  useAppStore(state => moteSessionId ? state.timelines[moteSessionId] : undefined)\n  const expression = useAppStore(state => {')],
  ['static-identity-subscribes-to-session', 'apps/desktop/src/renderer/src/components/MoteIdentityMotion.tsx', state, 'a static directory face', s => s.replace('export function MoteIdentityMotion(props: Props) {', 'export function MoteIdentityMotion(props: Props) {\n  useAppStore(state => state.timelines)')],
  ['stale-profiling-duration-counted-again', 'apps/desktop/scripts/fixtures/mote-navigation-footer/paperdoll.html', state, 'the profiling observer counts', s => s.replace(' && fiber.actualStartTime >= commit.start && fiber.actualStartTime <= commit.end', '')],
  ['profiling-misses-expression-owner', 'apps/desktop/scripts/fixtures/mote-navigation-footer/paperdoll.html', state, 'the profiling observer counts', s => s.replace("fiber.type.name === 'SessionMotion'", "fiber.type.name === 'MoteIdentityMotion'")],
  ['profiling-misses-zero-duration-work', 'apps/desktop/scripts/fixtures/mote-navigation-footer/paperdoll.html', state, 'the profiling observer counts', s => s.replace('!!(fiber.flags & 1)', 'fiber.actualDuration > 0')],
  ['current-gap-keeps-fake-live-tool', 'apps/desktop/src/renderer/src/lib/session-state.ts', state, 'a real current completion revision gap', s => s.replace('state: currentGap ?', 'state: false ?')],
  ['current-history-gap-keeps-fake-live-tool', 'apps/desktop/src/renderer/src/lib/session-state.ts', state, 'a current history revision gap', s => s.replace('state: currentGap ?', "state: currentGap && core.mutation.type === 'update' ?")],
  ['old-epoch-gap-stops-current-tool', 'apps/desktop/src/renderer/src/lib/session-state.ts', state, 'a current history revision gap', s => s.replace('evidence.observedAt >= epoch && evidence.observedAt >= observedAt &&', '')],
  ['old-item-gap-stops-current-tool', 'apps/desktop/src/renderer/src/lib/session-state.ts', state, 'a current history revision gap', s => s.replace("(mutation.type === 'update' || mutation.item.createdAt >= epoch)", 'true')],
  ['offscreen-keeps-moving', 'apps/desktop/src/renderer/src/lib/mote-face-motion.ts', state, 'offscreen, hidden', s => s.replace('identity.inView && ', '')],
  ['reduced-motion-keeps-moving', 'apps/desktop/src/renderer/src/lib/mote-face-motion.ts', state, 'offscreen, hidden', s => s.replace('&& !reduced.matches', '')]
]
const requested = process.argv.slice(2)
assert.equal(new Set(requested).size, requested.length, 'Each requested mutation is distinct')
for (const name of requested) assert.ok(variants.some(row => row[0] === name), 'Unknown mutation: ' + name)
const selected = requested.length ? variants.filter(row => requested.includes(row[0])) : variants
assert.ok(selected.length > 0, 'Nonempty actual mutation set')
result.selected = selected.map(row => row[0])
try {
  for (const directory of ['apps/desktop/src', 'apps/desktop/test', 'apps/desktop/resources', 'packages/core/src', 'packages/demand', 'packages/layout/src']) {
    await cp(join(repository, directory), join(clone, directory), { recursive: true, filter: file => !file.includes('/node_modules') && !file.includes('/dist') && !file.includes('/.tmp') })
  }
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json', 'packages/core/package.json', 'packages/layout/package.json', 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'apps/desktop/scripts/fixtures/mote-navigation-footer/paperdoll.html']) {
    await mkdir(resolve(clone, file, '..'), { recursive: true }); await cp(join(repository, file), join(clone, file))
  }
  for (const directory of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules']) {
    await mkdir(resolve(clone, directory, '..'), { recursive: true }); await symlink(join(repository, directory), join(clone, directory), 'dir')
  }
  const sourceFiles = await files(join(repository, 'apps/desktop/src')); assert.ok(sourceFiles.length > 0)
  for (const [symbol, definition, pattern] of [
    ['observeMoteMotion', 'apps/desktop/src/renderer/src/lib/mote-face-motion.ts', /\bobserveMoteMotion\(/],
    ['LiquidSelectionSurface', 'apps/desktop/src/renderer/src/components/settings/LiquidSelectionSurface.tsx', /<LiquidSelectionSurface\s/],
    ['MoteFace', 'apps/desktop/src/renderer/src/components/MoteFace.tsx', /<MoteFace\s/],
    ['MoteFaceEditor', 'apps/desktop/src/renderer/src/components/MoteFaceEditor.tsx', /<MoteFaceEditor\s/],
    ['MoteIdentityMotion', 'apps/desktop/src/renderer/src/components/MoteIdentityMotion.tsx', /<MoteIdentityMotion\s/],
    ['moteExpression', 'apps/desktop/src/renderer/src/lib/mote-expression.ts', /\bmoteExpression\(/],
    ['confirmed appearance save', 'apps/desktop/src/renderer/src/store.ts', /\.setSpaceObjectIcon\(/],
    ['projection event owner', 'apps/desktop/src/renderer/src/lib/session-state.ts', /\bprojectRuntimeEvent\(/]
  ]) {
    const hits = []
    for (const file of sourceFiles) if (relative(repository, file) !== definition) {
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => { if (!/^\s*import\b/.test(line) && pattern.test(line)) hits.push({ path: relative(repository, file), line: index + 1, text: line.trim() }) })
    }
    assert.ok(hits.length > 0, `No external product caller for ${symbol}`); result.callers[symbol] = hits
  }
  for (const [name, file, test, pattern, mutate] of selected) {
    const original = await readFile(join(clone, file)), changed = mutate(original.toString('utf8'))
    assert.notEqual(changed, original.toString('utf8'), `Actual Source mutation must land: ${name}`)
    result.files[file] = hash(original)
    await writeFile(join(evidence, name + '.source.txt'), changed)
    await writeFile(join(clone, file), changed)
    const red = await run(name + '.red.log', test, pattern)
    assert.notEqual(red.exit, 0, `${name}: real mutation must fail`); assert.match(red.output, /AssertionError:/)
    assert.doesNotMatch(red.output, /No test files found|Failed to load url|failed to resolve import|Transform failed|SyntaxError:/)
    await writeFile(join(clone, file), original)
    const green = await run(name + '.restored-green.log', test, pattern)
    assert.equal(green.exit, 0, `${name}: same restored Source passes`); assert.match(green.output, /Tests\s+\d+ passed/)
    result.cases.push({ name, path: file, original: hash(original), mutated: hash(changed), red: { ...red, output: undefined }, green: { ...green, output: undefined } })
  }
  assert.equal(result.cases.length, selected.length)
  for (const [file, digest] of Object.entries(result.files)) assert.equal(hash(await readFile(join(repository, file))), digest)
  result.passed = true
} catch (cause) { result.failure = { name: cause.name, message: cause.message, stack: cause.stack } }
finally { await rm(clone, { recursive: true, force: true }); result.cleanup = true; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2)) }
console.log(JSON.stringify({ passed: result.passed, receipt: join(evidence, 'receipt.json'), cases: result.cases.length, failure: result.failure }))
if (!result.passed) process.exitCode = 1
