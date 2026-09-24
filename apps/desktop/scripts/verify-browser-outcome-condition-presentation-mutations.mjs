import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const styles = 'apps/desktop/src/renderer/src/styles/'
const imports = [...(await readFile(resolve(root, styles, 'index.css'), 'utf8')).matchAll(/@import '\.\/([^']+)';/g)]
assert.ok(imports.length > 0, 'Derive the nonempty product stylesheet inputs from its actual entry')
const component = 'apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx'
const css = styles + 'browser-task-assets.css'
const result = `    {evaluation && <div className="browser-task-asset__progress" role="status">
      {evaluation.warning && <p>{evaluation.warning}</p>}
      {evaluation.conditions.map((condition, index) => <p key={index} data-outcome-status={condition.status}>{condition.reason}</p>)}
    </div>}`
const name = `browser-outcome-condition-presentation-${Date.now()}`
// The existing Source report writer is local to this new packet. Its last value
// is the final restored GREEN; each stage's original result remains in raw logs.
process.env.AGENTMUX_OUTCOME_CONTROL_STYLE_PROOF = resolve(root, '.tmp', name, 'style-last-restored-green.json')
await verifyRendererSourceMutations({
  name,
  tests: ['apps/desktop/test/browser-outcome-condition-presentation.test.tsx', 'apps/desktop/test/browser-outcome-control-style.test.tsx'],
  sources: [component, styles + 'index.css', ...imports.map(match => styles + match[1])],
  mutations: [
    { label: 'restore-repeated-completion-status-block', file: component, before: result,
      after: result.replace('      {evaluation.warning', '      <span>{labels[evaluation.status]}</span>\n      {evaluation.warning')
        .replace('{condition.reason}</p>', '{labels[condition.status]} · {condition.reason}</p>') },
    { label: 'restore-passed-condition-amber-block', file: css,
      before: ".browser-outcome-criteria .browser-task-asset__progress p[data-outcome-status='passed'] { color: var(--text-2); }",
      after: ".browser-outcome-criteria .browser-task-asset__progress p[data-outcome-status='passed'] { color: var(--amber-text); }" }
  ]
})
