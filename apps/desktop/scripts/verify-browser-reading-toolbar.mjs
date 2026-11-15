import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/browser-reading-toolbar')
const test = 'apps/desktop/test/browser-toolbar-layout.test.tsx'
const css = readFileSync(join(root, 'apps/desktop/src/renderer/src/styles/browser.css'), 'utf8')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const currentCss = sha(css)
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const tightReading = geometry => geometry.cases.find(item => item.width === 414 && item.zoom === 1 && item.active && !item.withProfile)
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--mutation')

if (args.length) {
  const anchor = '@container browser-pane (max-width: 520px) {'
  assert.equal(css.split(anchor).length, 2)
  const mutated = css.replace(anchor, '@container browser-pane (max-width: 380px) {')
  const scratch = mkdtempSync(join(tmpdir(), 'amux-toolbar-mutation-'))
  const alternate = join(scratch, 'browser.css'), reportPath = join(scratch, 'geometry.json')
  let rejected
  try {
    writeFileSync(alternate, mutated)
    const env = { ...process.env, AGENTMUX_TOOLBAR_LAYOUT_CSS: alternate, AGENTMUX_TOOLBAR_LAYOUT_PROOF: reportPath }
    delete env.AGENTMUX_TOOLBAR_LAYOUT_SHOTS
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', test, '--maxWorkers=1'], { cwd: root, env, encoding: 'utf8', timeout: 90_000 })
    const log = (run.stdout ?? '') + (run.stderr ?? '')
    writeFileSync(join(evidence, 'mutation.log'), log)
    assert.equal(run.status, 1, log)
    assert.match(log, /AssertionError/)
    const result = json(reportPath)
    assert.equal(result.browserCssSha256, sha(mutated))
    const reading = tightReading(result)
    assert.ok(reading && (reading.overflow > 0 || reading.buttons.some(button => !button.ownHit)), 'The 414px Browser must reproduce the crowded toolbar')
    rejected = { candidate: currentCss, mutant: result.browserCssSha256, reading }
  } finally {
    rmSync(scratch, { recursive: true })
  }
  writeFileSync(join(evidence, 'mutation.json'), JSON.stringify(rejected, null, 2) + '\n')
  console.log('Late collapse reproduced the crowded 414px toolbar in Chromium.')
} else {
  const after = join(evidence, 'after')
  const geometry = json(join(after, 'geometry.json'))
  const red = json(join(evidence, 'mutation.json'))
  assert.equal(geometry.browserCssSha256, currentCss)
  assert.equal(red.candidate, currentCss)
  assert.notEqual(red.mutant, currentCss)
  assert.match(readFileSync(join(after, 'test.log'), 'utf8'), /Tests\s+4 passed/)
  const scene = tightReading(geometry)
  assert.ok(scene && scene.address.width >= 96)
  for (const zoom of [1, 1.25]) for (const width of [234.5, 414]) {
    const actual = geometry.cases.find(item => item.active && item.zoom === zoom && item.width === width && item.withProfile)
    assert.ok(actual && !actual.overflow && actual.focusedMore && actual.focusedClose && actual.focusedDiscussion)
    assert.ok(actual.buttons.every(button => button.hitSamples.every(Boolean)))
  }
  const review = json(join(after, 'independent-visual-review.json'))
  assert.equal(review.passed, true)
  assert.ok(review.reviewer)
  for (const file of ['active-234.5.png', 'active-414.png', 'active-650.png', 'active-880.png', 'profile-234.5.png', 'profile-414.png']) {
    const viewed = review.images.find(image => image.file === file)
    assert.ok(viewed, 'Actual independently reviewed image: ' + file)
    assert.equal(viewed.sha256, sha(readFileSync(join(after, file))))
  }
  console.log('Browser toolbar qualified at both UI zoom levels with actual hit tests, a rejected mutation and independent screenshots.')
}
