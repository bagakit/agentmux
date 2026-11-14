// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const script = join(root, 'apps/desktop/scripts/inventory-ui-components.mjs')
const output = join(root, 'docs/reviews/ui-component-inventory.json')
let inventory

beforeAll(() => {
  execFileSync(process.execPath, [script, '--verify'], { cwd: root, stdio: 'pipe' })
  inventory = JSON.parse(readFileSync(output, 'utf8'))
})

describe('production UI component inventory', () => {
  it('derives real shared components and every SelectionField consumer form', () => {
    const components = new Set(inventory.components.map(item => item.name))
    for (const name of ['Button', 'IconButton', 'FormRow', 'SelectionField', 'AgentExecutorPicker', 'AgentComposer', 'ConversationMessage', 'MobileGoalsSurface']) expect(components.has(name)).toBe(true)
    const selection = inventory.consumers.filter(item => item.component === 'SelectionField')
    expect(selection.length).toBeGreaterThanOrEqual(26)
    for (const kind of ['import', 'jsx', 'literal-path', 'dynamic-path']) expect(selection.some(item => item.kind === kind)).toBe(true)
    for (const file of ['apps/desktop/src/renderer/src/components/AgentWorkModeSetup.tsx', 'apps/desktop/src/renderer/src/components/SurveyProfilePicker.tsx', 'apps/desktop/scripts/capture-space-launcher.mjs'])
      expect(selection.some(item => item.file === file)).toBe(true)
  })

  it('covers native select surfaces and names independently verifiable follow-up work', () => {
    const nativeFiles = new Set(inventory.nativeSelects.map(item => item.file))
    for (const file of [
      'apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx',
      'apps/desktop/src/renderer/src/components/settings/NetworkNodeSettingsPane.tsx',
      'apps/desktop/src/renderer/src/components/settings/FocusMapSettings.tsx',
      'apps/mobile/src/goals/MobileGoalsSurface.tsx',
      'apps/mobile/src/goals/MobileGoalCreate.tsx',
    ]) expect(nativeFiles.has(file)).toBe(true)
    const future = new Set(inventory.futureFeatures.map(item => item.id))
    for (const id of ['ui-shared-selection-package', 'ui-mobile-selection-consistency', 'ui-typography-consistency', 'ui-rich-composite-consistency', 'ui-component-directory-cohesion']) {
      expect(future.has(id)).toBe(true)
      const feature = inventory.futureFeatures.find(item => item.id === id)
      expect(feature.owner).toBeTruthy()
      expect(feature.verification.length).toBeGreaterThan(0)
    }
  })
})

describe('inventory counterexamples', () => {
  const fixture = join(root, '.tmp/ui-component-inventory-fixture')
  function seed() {
    rmSync(fixture, { recursive: true, force: true })
    for (const directory of ['packages/client-ui/src/components', 'apps/desktop/src/renderer/src/components', 'apps/desktop/src/renderer/src/styles', 'apps/desktop/scripts', 'apps/mobile/src/goals']) mkdirSync(join(fixture, directory), { recursive: true })
    writeFileSync(join(fixture, 'packages/client-ui/src/components/Button.tsx'), 'export function Button() { return <button /> }\n')
    writeFileSync(join(fixture, 'packages/client-ui/src/components/SelectionField.tsx'), 'export function SelectionField() { return <button /> }\n')
    writeFileSync(join(fixture, 'apps/desktop/src/renderer/src/components/Example.tsx'), 'import { SelectionField } from "./SelectionField"\nexport const Example = () => <SelectionField />\n')
    writeFileSync(join(fixture, 'apps/desktop/scripts/dynamic.mjs'), 'export const file = join(ROOT, "components/SelectionField.tsx")\n')
    writeFileSync(join(fixture, 'apps/desktop/src/renderer/src/styles/example.css'), '.example { color: var(--missing-token); }\n')
    writeFileSync(join(fixture, 'apps/mobile/src/goals/MobileGoalsSurface.tsx'), 'export const Field = () => <select />\n')
  }

  it('fails when the only real consumer disappears and detects component CSS issues', () => {
    seed()
    rmSync(join(fixture, 'apps/desktop/src/renderer/src/components/Example.tsx'))
    expect(() => execFileSync(process.execPath, [script, '--root', fixture, '--verify'], { cwd: root, stdio: 'pipe' })).toThrow()
    const report = JSON.parse(execFileSync(process.execPath, [script, '--root', fixture], { cwd: root, encoding: 'utf8' }))
    expect(report.styleIssues.some(item => item.property === '--missing-token')).toBe(true)
    rmSync(fixture, { recursive: true, force: true })
  })
})
