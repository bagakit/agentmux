import assert from 'node:assert/strict'

const args=process.argv.slice(2)
assert.equal(args.length,2,'One explicit bounded Native slice')
assert.equal(args[0],'--slice','Explicit slice argument')
assert.ok(args[1]==='capability'||args[1]==='product','Known Native slice')
if(args[1]==='product')await import('./fixtures/shared-native-presentation-product/product-proof.mjs')
else await import('./fixtures/shared-native-presentation-capability/browser-pane-proof.mjs')
