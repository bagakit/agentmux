import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'
import base from '../../../vitest.config'
import { aliases as currentSources } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const root = resolve(import.meta.dirname, '../../..')
const dependency = createRequire(resolve(root, 'apps/desktop/package.json'))
const react = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => ({ find: new RegExp('^' + name + '$'), replacement: dependency.resolve(name) }))
const host = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports
const aliases = Object.entries(host).map(([key, value]: [string, any]) => ({
  find: '@agentmux/host' + (key === '.' ? '' : key.slice(1)),
  replacement: resolve(root, 'apps/host', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
const mutant = process.env.SURVEY_AGENT_MUTANT
const edits: Record<string, [string, string, string]> = {
  context: ['components/BrowserPane.tsx', "target.surface === 'survey' || target.survey ? 'survey' : undefined", 'undefined'],
  global: ['store.ts', 'if (localFocus) {\n            if (!ownsLocalTarget(address)) return', 'if (false) {\n            if (!ownsLocalTarget(address)) return'],
  late: ['store.ts', 'localFocus && !navigationChanged &&', 'localFocus &&'],
  selected: ['store.ts', 'get().setSurveyZoneSelection(surveySelectReference(get().surveyZoneSelection!, address))', 'void address'],
}
assert.ok(!mutant || edits[mutant])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base,
  resolve: { alias: [...react, ...aliases, ...currentSources] },
  plugins: [{ name: 'survey-agent-navigation-owner', enforce: 'pre', transform(code, id) {
    if (!mutant || !id.endsWith('/' + edits[mutant]![0])) return
    const [, before, after] = edits[mutant]!
    assert.equal(code, readFileSync(id, 'utf8'))
    assert.equal(code.split(before).length - 1, 1, 'Exactly one original navigation owner anchor')
    const output = code.replace(before, after)
    appendFileSync(process.env.SURVEY_AGENT_MUTATION_HITS!, JSON.stringify({ mutant, id, original: sha(code), consumed: sha(output) }) + '\n')
    return { code: output, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/space-agent-control.test.ts', 'apps/desktop/test/survey-surface.test.tsx'],
    testNamePattern: /mounted Survey Browser|creates an Agent launcher in the clicked unselected item|explicit focus navigates|delayed focused launch/,
    maxWorkers: 1, passWithNoTests: false, testTimeout: 30000 }
})
