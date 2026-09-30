import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const repository = path.resolve(import.meta.dirname, '../../../../..')
const main = path.join(import.meta.dirname, 'paperdoll-main.cjs'), source = fs.readFileSync(main, 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = path.join(repository, '.tmp/mote-paperdoll-image-seed', String(Date.now()))
fs.mkdirSync(evidence, { recursive: true })
const sources = {}
const compiledModule = file => {
  const bytes = fs.readFileSync(path.join(repository, file))
  const compiled = ts.transpileModule(bytes.toString(), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  sources[file] = { original: hash(bytes), transpiled: hash(compiled) }
  return compiled
}
const dataModule = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const shared = dataModule(compiledModule('apps/desktop/src/shared/mote-avatars.ts'))
let guard = compiledModule('apps/desktop/src/main/mote-avatar-image.ts')
assert.match(guard, /(['"])\.\.\/shared\/mote-avatars\.js\1/)
guard = guard.replace(/(['"])\.\.\/shared\/mote-avatars\.js\1/, JSON.stringify(shared))
const { decodeMoteAvatar, moteAvatarPng } = await import(dataModule(guard))
const { controlledNativeImage, imagePng } = await import(dataModule(compiledModule('apps/desktop/test/fixtures/mote-identity-image.ts')))
const originalFile = path.join(repository, 'apps/desktop/src/renderer/src/assets/pmo-teams-topic-avatar.png')
const originalBytes = fs.readFileSync(originalFile), originalSha256 = hash(originalBytes)
assert.ok(originalBytes.length > 0)
const receipt = { schema: 'agentmux.mote-paperdoll-image-seed-source.v1', passed: false, source: { path: path.relative(repository, main), sha256: hash(source) }, sources,
  boundary: 'Original private seed preparation and original product decode/crop guard execute with the existing controlledNativeImage Node boundary. Actual Electron nativeImage pixels and filesystem owner remain Root actual acceptance.', actualCompileCapture: false, userAppOrRunTouched: false, cases: [], mutations: [] }

function prepare(text) {
  const start = text.indexOf('      const originalImageFile ='), end = text.indexOf('      image = await topics.saveAvatar', start)
  assert.ok(start >= 0 && end > start, 'The original preparation block has two real anchors')
  const block = text.slice(start, end)
  assert.match(block, /originalImage\.resize/); assert.match(block, /result\.imagePreparation/)
  // VM objects have a distinct prototype; compare the same dimension data across this Node test boundary.
  const assertions = { ...assert, deepEqual: (left, right, message) => assert.deepEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)), message) }
  return runInNewContext('(() => {\n' + block + '\nreturn { png, preparation: result.imagePreparation }; })()', {
    fs, path, repository, hash, assert: assertions, Buffer, result: {}, nativeImage: { createFromBuffer: controlledNativeImage }
  })
}
function acceptance(text) {
  const prepared = prepare(text)
  assert.ok(prepared.png.length > 0)
  assert.equal(prepared.png.readUInt32BE(16), 256); assert.equal(prepared.png.readUInt32BE(20), 256)
  const decoded = decodeMoteAvatar({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + prepared.png.toString('base64') }, controlledNativeImage)
  assert.deepEqual(moteAvatarPng(decoded), prepared.png)
  assert.equal(hash(fs.readFileSync(originalFile)), originalSha256, 'Original nonempty user file remains unchanged')
  return prepared
}
test('the original seed prepares a nonempty 256 PNG accepted by the unchanged real crop guard', () => {
  const prepared = acceptance(source)
  assert.equal(prepared.preparation.originalSha256, originalSha256)
  assert.equal(prepared.preparation.originalSize.width, 1024); assert.equal(prepared.preparation.originalSize.height, 1024)
  assert.throws(() => moteAvatarPng(controlledNativeImage(originalBytes)), /256 pixel avatar crop/)
  assert.throws(() => moteAvatarPng(controlledNativeImage(imagePng(128, 128))), /256 pixel avatar crop/)
  receipt.cases.push('nonempty real 1024 source unchanged; prepared 256 PNG accepted', 'original 1024 and malformed 128 crop rejected by original product guard')
})
test('bad seed resize and direct original-file save regressions make actual preparation acceptance red', () => {
  const variants = [
    ['wrong crop dimension', "originalImage.resize({ width: 256, height: 256, quality: 'best' })", "originalImage.resize({ width: 128, height: 128, quality: 'best' })"],
    ['uncropped original image', "originalImage.resize({ width: 256, height: 256, quality: 'best' })", 'originalImage']
  ]
  assert.equal(variants.length, 2)
  for (const [name, anchor, replacement] of variants) {
    assert.ok(source.includes(anchor)); const changed = source.replace(anchor, replacement); assert.notEqual(changed, source)
    let red
    try { acceptance(changed) } catch (error) { red = error }
    assert.equal(red?.name, 'AssertionError', 'A real dimension assertion must be red: ' + name)
    acceptance(source)
    receipt.mutations.push({ name, original: hash(source), mutated: hash(changed), red: { name: red.name, message: red.message }, restoredGreen: true })
    fs.writeFileSync(path.join(evidence, name.replaceAll(' ', '-') + '.source.cjs'), changed)
  }
  assert.equal(hash(fs.readFileSync(main)), hash(source)); receipt.passed = true
  fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, receipt: path.join(evidence, 'receipt.json'), cases: receipt.cases.length, mutations: receipt.mutations.length }))
})
