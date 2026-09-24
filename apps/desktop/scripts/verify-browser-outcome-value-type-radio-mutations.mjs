import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

// Mounted component/state/finite declarations and real Core socket consumer.
// The radio input sender is an explicit model; no Desktop or Native run here.
await verifyRendererSourceMutations({
  "name": "browser-outcome-visible-value-type-radio-source-mutations",
  "tests": [
    "apps/desktop/test/browser-outcome-value-type-radio.test.tsx",
    "apps/desktop/test/browser-outcome-probe-scenario.test.ts"
  ],
  "sources": [
    "apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx",
    "apps/desktop/scripts/browser-outcome-probe-scenario.mjs",
    "apps/desktop/src/renderer/src/styles/browser-task-assets.css",
    "apps/desktop/src/main/browser-structured-output.ts",
    "apps/desktop/src/shared/browser-structured-output.ts",
    "apps/desktop/src/shared/browser-outcome-criteria.ts",
    "apps/desktop/scripts/browser-demonstration-probe-scenario.mjs",
    "apps/desktop/scripts/browser-demonstration-probe-diagnostics.mjs",
    "apps/desktop/src/main/browser-completion-control.ts",
    "packages/core/src/control.ts",
    "packages/core/src/control-host.ts",
    "packages/core/src/browser-completion-facts.ts",
    "packages/core/dist/index.js",
    "packages/core/dist/browser-completion-facts.js",
    "apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs",
    "apps/desktop/scripts/verify-browser-outcome-value-type-radio-mutations.mjs"
  ],
  "mutations": [
    {
      "label": "mounted-radio-state-disconnected",
      "file": "apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx",
      "before": "onChange={() => setType(value)}",
      "after": "onChange={() => {}}"
    },
    {
      "label": "browser-radio-groups-share-name",
      "file": "apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx",
      "before": "const typeName = useId()",
      "after": "const typeName = \"shared-value-type\""
    },
    {
      "label": "checked-state-does-not-follow-type",
      "file": "apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx",
      "before": "checked={type === value}",
      "after": "checked={value === 'string'}"
    },
    {
      "label": "typed-json-value-not-converted",
      "file": "apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx",
      "before": "value = JSON.parse(expected)",
      "after": "value = expected"
    },
    {
      "label": "checked-condition-reads-text",
      "file": "apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx",
      "before": "read: type === 'boolean' ? 'checked' : 'text'",
      "after": "read: 'text'"
    },
    {
      "label": "selected-declaration-forced-string",
      "file": "apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx",
      "before": "fields: [{ key, type, source:",
      "after": "fields: [{ key, type: \"string\", source:"
    },
    {
      "label": "invalid-declared-type-accepted",
      "file": "apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx",
      "before": "if (typeof value !== type || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Wrong value type')",
      "after": "if (false) throw new Error(\"Wrong value type\")"
    },
    {
      "label": "radio-keyboard-tab-omitted",
      "file": "apps/desktop/scripts/browser-outcome-probe-scenario.mjs",
      "before": "  await key(ctx, 'Tab', 'Tab', 9)\n",
      "after": ""
    },
    {
      "label": "number-radio-standard-arrow-omitted",
      "file": "apps/desktop/scripts/browser-outcome-probe-scenario.mjs",
      "before": "  else if (before === 'string') await key(ctx, 'ArrowRight', 'ArrowRight', 39)\n",
      "after": "  else if (before === 'string') {}\n"
    },
    {
      "label": "actual-checked-choice-not-verified",
      "file": "apps/desktop/scripts/browser-outcome-probe-scenario.mjs",
      "before": "  assert.equal(observed.afterCommit.value, 'number', 'Actual keyboard input selects the numeric radio')\n  assert.deepEqual(observed.afterCommit.selected, ['number']); assert.equal(observed.afterCommit.focused, true)\n",
      "after": ""
    },
    {
      "label": "checked-choice-replaced-by-first-radio",
      "file": "apps/desktop/scripts/browser-outcome-probe-scenario.mjs",
      "before": "value:selected[0].value",
      "after": "value:controls[0].value"
    },
    {
      "label": "numeric-zero-not-entered",
      "file": "apps/desktop/scripts/browser-outcome-probe-scenario.mjs",
      "before": "  await type(ctx, 'Equals', '0')\n",
      "after": ""
    }
  ]
})
