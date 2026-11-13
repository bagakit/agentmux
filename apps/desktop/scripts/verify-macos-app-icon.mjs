import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { APP_ICON_IDS } from '../../../packages/client-ui/src/lib/app-icon-catalog.ts'
import { renderClassicAppIcon } from './lib/classic-app-icon.mjs'
import { renderMacOSAppIcon } from './lib/macos-app-icon.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp/app-icon-macos-shape', randomUUID())
await mkdir(evidence, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = {}
const resourceRoot = join(root, 'apps/desktop/resources')

// Decode the actual output, independently of the shaping SVG's geometry.
function assertMacShape(png, size) {
  const decoded = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image width="${size}" height="${size}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`, { font: { loadSystemFonts: false } }).render()
  assert.equal(decoded.width, size)
  const pixels = decoded.pixels
  const alpha = (x, y) => pixels[(Math.floor(y) * size + Math.floor(x)) * 4 + 3]
  let left = size, top = size, right = -1, bottom = -1
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (alpha(x, y) > 128) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
  }
  const bounds = [left, top, right + 1, bottom + 1]
  const expected = [size * 100 / 1024, size * 100 / 1024, size * 924 / 1024, size * 924 / 1024]
  bounds.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= 1, `Dock artwork has balanced transparent margins: ${bounds}`))
  for (const [x, y] of [[.12, .12], [.88, .12], [.12, .88], [.88, .88]]) {
    assert.equal(alpha(size * x, size * y), 0, 'All four inset artwork corners are rounded, not square')
  }
  assert.ok(alpha(size * .5, size * .13) > 128, 'The centered top edge remains visible')
  assert.ok(alpha(size * .22, size * .22) > 128, 'Rounded corner retains artwork inside its contour')
  return bounds
}

for (const id of APP_ICON_IDS) {
  const raw = await readFile(join(root, 'packages/client-ui/brand/app-icons', id + '.png'))
  const source = id === 'classic' ? renderClassicAppIcon(raw) : raw
  const native = await readFile(join(resourceRoot, 'app-icons/macos', id + '.png'))
  const shared = await readFile(join(root, 'packages/client-ui/src/assets/app-icons', id + '.png'))
  assert.equal(sha(native), sha(renderMacOSAppIcon(source, 512)), 'Production build consumes the real shaping owner')
  assert.equal(sha(shared), sha(await readFile(join(resourceRoot, 'app-icons', id + '.png'))), 'Non-macOS and browser assets remain unpadded')
  inputs[id] = { source: sha(raw), native: sha(native), bounds: assertMacShape(native, 512) }
}
assertMacShape(await readFile(join(resourceRoot, 'icon.png')), 1024)
const iconset = join(evidence, 'default.iconset')
execFileSync('iconutil', ['-c', 'iconset', '-o', iconset, join(resourceRoot, 'icon.icns')])
for (const [filename, size] of [['icon_32x32.png', 32], ['icon_128x128.png', 128], ['icon_512x512@2x.png', 1024]]) {
  assertMacShape(await readFile(join(iconset, filename)), size)
}

const helperPath = join(root, 'apps/desktop/scripts/lib/macos-app-icon.mjs')
const helper = await readFile(helperPath, 'utf8')
const original = await readFile(join(root, 'packages/client-ui/brand/app-icons/qingzhuan.png'))
for (const [name, before, after, count] of [
  ['no-padding', 'x="100" y="100" width="824" height="824"', 'x="0" y="0" width="1024" height="1024"', 2],
  ['no-rounding', 'clip-path="url(#macos-icon)"', '', 1]
]) {
  assert.equal(helper.split(before).length - 1, count, 'Exact shaping owner mutation anchors')
  const source = helper.replaceAll(before, after).replace("'@resvg/resvg-js'", JSON.stringify(import.meta.resolve('@resvg/resvg-js')))
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  assert.throws(() => assertMacShape(mutant.renderMacOSAppIcon(original, 512), 512), assert.AssertionError, 'A real pixel assertion kills ' + name)
}

const runs = []
for (const name of ['baseline', 'macos-path']) {
  const report = join(evidence, name + '.json'), mutationLog = join(evidence, name + '-source.txt')
  let code = 0, output = ''
  try {
    output = execFileSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
      'apps/desktop/test/vitest.app-icon.config.mts', 'apps/desktop/test/app-brand-icon.test.ts', '--reporter=json', '--outputFile', report],
    { cwd: root, encoding: 'utf8', env: { ...process.env, ...(name === 'baseline' ? {} : { AGENTMUX_APP_ICON_MUTANT: name, AGENTMUX_APP_ICON_MUTATION_LOG: mutationLog }) } })
  } catch (cause) { code = cause.status; output = String(cause.stdout) + String(cause.stderr) }
  await writeFile(join(evidence, name + '.log'), output)
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.ok(result.numTotalTests > 0 && result.testResults.every(suite => suite.assertionResults.length > 0), 'Nonempty production native consumer assertions, not collection errors')
  if (name === 'baseline') assert.equal(code, 0, output)
  else {
    assert.notEqual(code, 0)
    assert.ok(result.numFailedTests > 0)
    assert.ok((await readFile(mutationLog, 'utf8')).trim())
  }
  runs.push({ name, code, tests: result.numTotalTests, failed: result.numFailedTests })
}
assert.equal(await readFile(helperPath, 'utf8'), helper, 'Verification never modifies the production owner')
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ passed: true, inputs, runs, mutations: ['no-padding', 'no-rounding', 'macos-path'],
  boundary: 'Real generated PNG/icns and production Native adapter tests. Actual Dock appearance and independent review have separate receipts.' }, null, 2))
console.log(JSON.stringify({ passed: true, evidence }))
