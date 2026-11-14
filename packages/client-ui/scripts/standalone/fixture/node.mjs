import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@agentmux/client-ui/components/Button'
import { resolveTheme } from '@agentmux/client-ui/theme/model'
import { AgentWorkLocationTrigger } from '@agentmux/client-ui/patterns/agent-work-location'

const location = new URL('./node_modules/@agentmux/client-ui/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', location), 'utf8'))
const counts = { code: 0, css: 0 }
for (const [key, target] of Object.entries(manifest.exports)) {
  const entry = manifest.name + key.slice(1)
  const file = fileURLToPath(import.meta.resolve(entry))
  assert.equal(await realpath(file), fileURLToPath(new URL(typeof target === 'string' ? target : target.import, location)))
  if (typeof target === 'string') {
    assert.ok((await readFile(file)).byteLength > 0)
    counts.css++
  } else {
    assert.ok(Object.keys(await import(entry)).length > 0)
    counts.code++
  }
}
assert.equal(typeof document, 'undefined')
assert.equal(typeof window, 'undefined')
assert.equal(resolveTheme({ themeId: 'graphite', appAppearance: 'light' }).mode, 'light')
assert.match(renderToStaticMarkup(createElement(Button, { 'aria-pressed': true }, 'Pin board')), /aria-pressed="true"/u)
assert.match(renderToStaticMarkup(createElement(AgentWorkLocationTrigger, {
  agentName: 'Mira', summary: { state: 'confirmed', count: 2 }, actionLabel: 'Choose location',
  describeSummary: value => value.state === 'confirmed' ? `${value.count} open locations` : 'Locations unconfirmed'
})), /Mira · 2 open locations · Choose location/u)
assert.throws(() => import.meta.resolve(manifest.name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
console.log(JSON.stringify({ ...counts, staticMarkup: true, idleNode: true }))
