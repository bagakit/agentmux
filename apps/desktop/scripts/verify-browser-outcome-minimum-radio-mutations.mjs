import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/scripts/browser-outcome-probe-scenario.mjs'
await verifyRendererSourceMutations({
  name: `browser-outcome-minimum-radio-mutations-${Date.now()}`,
  tests: ['apps/desktop/test/browser-outcome-minimum-radio.test.tsx', 'apps/desktop/test/browser-outcome-probe-scenario.test.ts'],
  sources: [file, 'apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx',
    'apps/desktop/scripts/browser-demonstration-probe-scenario.mjs',
    'apps/desktop/scripts/browser-demonstration-probe-diagnostics.mjs',
    'apps/desktop/src/main/browser-completion-control.ts', 'packages/core/src/control.ts',
    'packages/core/src/control-host.ts', 'packages/core/src/browser-completion-facts.ts',
    'packages/core/dist/index.js', 'packages/core/dist/browser-completion-facts.js'],
  mutations: [
    { label: 'minimum-radio-clipped-text-accepted', file,
      before: "    assert.ok(radio.textLines > 0 && radio.textLines <= 2, 'Actual choice text remains readable')\n", after: '' },
    { label: 'minimum-radio-covered-edge-accepted', file,
      before: "    assert.deepEqual(radio.points.map(point => point.owned), [true, true, true, true, true], 'Every actual label owns its center and four edge points')\n", after: '' },
    { label: 'minimum-radio-page-consumed', file,
      before: "  assert.ok(value.stage.width > 0 && value.stage.height > 0, 'The actual page retains positive area')\n", after: '' },
    { label: 'minimum-radio-wrong-split-width', file,
      before: "  assert.equal(value.region.width, 234.5, 'The real supported minimum two-Region Browser must be measured')\n", after: '' },
    { label: 'original-number-radio-arrow-lost', file,
      before: "  else if (before === 'string') await key(ctx, 'ArrowRight', 'ArrowRight', 39)\n", after: "  else if (before === 'string') {}\n" }
  ]
})
