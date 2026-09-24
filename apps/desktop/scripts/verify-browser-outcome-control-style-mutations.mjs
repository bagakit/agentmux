import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const styles = 'apps/desktop/src/renderer/src/styles/'
const imports = [...(await readFile(resolve(root, styles, 'index.css'), 'utf8')).matchAll(/@import '\.\/([^']+)';/g)]
assert.ok(imports.length > 0, 'The actual stylesheet entry must load product styles')
const component = 'apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx'
const css = styles + 'browser-operation-surface.css'
await verifyRendererSourceMutations({
  name: `browser-outcome-control-style-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/browser-outcome-control-style.test.tsx'],
  sources: [component, styles + 'index.css', ...imports.map(match => styles + match[1])],
  mutations: [
    { label: 'check-action-loses-real-control-classes', file: component,
      before: '<div className="browser-task-asset__run-actions"><button className="browser-rsi-button browser-rsi-button--primary browser-rsi-replay__run"',
      after: '<div className="browser-task-asset__run-actions"><button className="browser-rsi-replay__run"' },
    { label: 'verify-action-loses-real-control-classes', file: component,
      before: '{evaluation && onVerify && <button className="browser-rsi-button browser-rsi-button--primary browser-rsi-replay__run"',
      after: '{evaluation && onVerify && <button className="browser-rsi-replay__run"' },
    { label: 'reused-hover-rule-missing', file: css,
      before: '.browser-rsi-button--primary:hover:not(:disabled) { background: var(--green-bg-hover); }', after: '' },
    { label: 'reused-disabled-rule-missing', file: css,
      before: '.browser-rsi-button:disabled, .browser-rsi-icon-button:disabled', after: '.browser-rsi-icon-button:disabled' },
    { label: 'reused-focus-rule-missing', file: css,
      before: '.browser-rsi-button:focus-visible, .browser-rsi-icon-button:focus-visible', after: '.browser-rsi-icon-button:focus-visible' }
  ]
})
