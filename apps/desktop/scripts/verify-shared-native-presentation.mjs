import assert from 'node:assert/strict'

const args=process.argv.slice(2)
assert.ok(args.length >= 2, 'One explicit bounded Native slice')
assert.equal(args[0],'--slice','Explicit slice argument')
assert.ok(args[1]==='capability'||args[1]==='product','Known Native slice')
const options = args.slice(2)
if (args[1] === 'product') {
  assert.ok(options.length === 0 || options.length === 1 &&
    ['--mote-responsive', '--mote-responsive-without-layout-host'].includes(options[0]), 'Known product fixture option')
  await import('./fixtures/shared-native-presentation-product/product-proof.mjs')
} else {
  assert.equal(options.length, 0, 'The capability slice has no options')
  await import('./fixtures/shared-native-presentation-capability/browser-pane-proof.mjs')
}
