import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { APP_ICON_IDS } from '../../../packages/client-ui/src/lib/app-icon-catalog.ts'
import { renderClassicAppIcon } from './lib/classic-app-icon.mjs'
import { renderMacOSAppIcon } from './lib/macos-app-icon.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp/classic-icon-retro', randomUUID())
await mkdir(evidence, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const rawPath = 'packages/client-ui/brand/app-icons/classic.png'
const raw = await readFile(join(root, rawPath))
assert.equal(sha(raw), '98761cbedb68ca1462f2931e84069bb7c875ddd8ff0f224b2131305a23c3e8cc', 'The exact original dragon is retained')
const backdrop = await readFile(join(root, 'packages/client-ui/brand/app-icons/classic-backplate.svg'), 'utf8')
assert.doesNotMatch(backdrop, /<text\b|data:image|<image\b/i, 'The backplate does not duplicate the original PNG or add text')

function decode(png, size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image width="${size}" height="${size}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`
  const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render()
  assert.equal(image.width, size)
  assert.equal(image.height, size)
  return (x, y) => [...image.pixels.subarray((Math.floor(y) * size + Math.floor(x)) * 4, (Math.floor(y) * size + Math.floor(x)) * 4 + 4)]
}

function assertBackplate(png, macOS = false) {
  const pixel = decode(png, 512)
  const coordinate = value => macOS ? (100 + 824 * value) / 2 : 512 * value
  for (const [x, y] of [[.13, .5], [.5, .07], [.24, .24]]) {
    const [r, g, b, alpha] = pixel(coordinate(x), coordinate(y))
    assert.equal(alpha, 255, 'The real Classic output has a backplate outside the dragon silhouette')
    assert.ok(r > 140 && g > 140 && b > 120 && Math.max(r, g, b) - Math.min(r, g, b) < 65, 'The backplate remains a muted warm grey-green')
  }
  assert.equal(pixel(0, 0)[3], 0, 'The rounded plate has transparent canvas corners')
  assert.ok(pixel(256, 256)[1] > pixel(256, 256)[0], 'The original green dragon remains visible in front of the plate')
  if (macOS) {
    assert.equal(pixel(256, 45)[3], 0, 'The macOS canvas retains its outer transparent padding')
    assert.equal(pixel(256, 52)[3], 255, 'The macOS plate begins at the shared native safe outline')
  }
}

const composed = renderClassicAppIcon(raw)
assert.equal(sha(composed), sha(renderClassicAppIcon(raw)), 'Composition is deterministic')
const composedPath = join(evidence, 'classic-composed.png')
const resizedPath = join(evidence, 'classic-shared.png')
await writeFile(composedPath, composed)
await writeFile(resizedPath, renderClassicAppIcon(raw, 512))
const sharedPath = join(root, 'packages/client-ui/src/assets/app-icons/classic.png')
const shared = await readFile(sharedPath)
const runtime = await readFile(join(root, 'apps/desktop/resources/app-icons/classic.png'))
const macOS = await readFile(join(root, 'apps/desktop/resources/app-icons/macos/classic.png'))
assert.equal(sha(shared), sha(await readFile(resizedPath)), 'Published Classic consumes the single composition owner')
assert.equal(sha(runtime), sha(shared), 'Non-macOS and bot/browser consumers share the same Classic bytes')
assert.equal(sha(macOS), sha(renderMacOSAppIcon(composed, 512)), 'macOS only adds its existing native outer treatment')
assertBackplate(shared)
assertBackplate(macOS, true)

// This task intentionally changes only Classic; protect the previously accepted A-D outputs.
const unchanged = {}
for (const id of APP_ICON_IDS.filter(id => id !== 'classic')) {
  for (const path of [`packages/client-ui/brand/app-icons/${id}.png`, `packages/client-ui/src/assets/app-icons/${id}.png`,
    `apps/desktop/resources/app-icons/${id}.png`, `apps/desktop/resources/app-icons/macos/${id}.png`]) {
    const bytes = await readFile(join(root, path))
    assert.equal(sha(bytes), sha(execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 })), 'A-D retain their already accepted bytes: ' + path)
    unchanged[path] = sha(bytes)
  }
}

const helperPath = join(root, 'apps/desktop/scripts/lib/classic-app-icon.mjs')
const helper = await readFile(helperPath, 'utf8')
const before = '<image width="1024" height="1024" href="data:image/svg+xml;base64,${backplate.toString(\'base64\')}"/>'
assert.equal(helper.split(before).length - 1, 1, 'One exact real background-removal mutation anchor')
const mutationSource = helper.replace(before, '').replace('import.meta.url', JSON.stringify(pathToFileURL(helperPath).href))
  .replace("'@resvg/resvg-js'", JSON.stringify(import.meta.resolve('@resvg/resvg-js')))
const mutant = await import('data:text/javascript;base64,' + Buffer.from(mutationSource).toString('base64'))
assert.throws(() => assertBackplate(mutant.renderClassicAppIcon(raw, 512)), assert.AssertionError, 'Actual background pixels kill removal of the production backplate')
assert.equal(await readFile(helperPath, 'utf8'), helper, 'Mutation leaves production source unchanged')

const runs = []
for (const [name, config, files] of [
  ['settings-native', 'apps/desktop/test/vitest.app-icon.config.mts', ['apps/desktop/test/app-icon-choice.test.tsx', 'apps/desktop/test/app-brand-icon.test.ts']],
  ['bot-asset', 'apps/desktop/test/vitest.app-icon-consumers.config.mts', ['apps/desktop/test/app-icon-asset-consumers.test.ts']]
]) {
  const report = join(evidence, name + '.json')
  const output = execFileSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, ...files,
    '--reporter=json', '--outputFile', report], { cwd: root, encoding: 'utf8' })
  await writeFile(join(evidence, name + '.log'), output)
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.ok(result.numTotalTests > 0 && result.testResults.every(suite => suite.assertionResults.length > 0), 'Nonempty existing product consumer assertions')
  assert.equal(result.numFailedTests, 0)
  runs.push({ name, tests: result.numTotalTests, failed: result.numFailedTests })
}

const receipt = { passed: true, raw: sha(raw), background: sha(Buffer.from(backdrop)), shared: sha(shared), macOS: sha(macOS), unchanged,
  mutations: ['no-backplate'], runs, boundary: 'Actual generated Classic assets and existing Settings, native and bot consumers. Real Dock/Settings visual review has separate evidence.' }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ passed: true, evidence }))
