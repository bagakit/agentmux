import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allStyleRules, stripCssComments, styleFiles } from './helpers/styles.js'

function stylesheet(name: string): string {
  const found = styleFiles().find(file => file.name === name)
  expect(found, `${name} must be in the real production import graph`).toBeDefined()
  expect(found!.text.trim().length).toBeGreaterThan(0)
  return stripCssComments(found!.text)
}

function bodies(source: string, selector: string): string[] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1]!.trim().replace(/\s+/g, ' ') === selector)
    .map(match => match[2]!)
}

function oneRule(source: string, selector: string): string {
  const found = bodies(source, selector)
  expect(found, `${selector} has one owning default`).toHaveLength(1)
  expect(found[0]!.trim().length).toBeGreaterThan(0)
  return found[0]!
}

describe('design consistency owning rules', () => {
  it('gives the Portal panel its own named query container and keeps its narrow override after the default', () => {
    const launcher = stylesheet('launcher.css')
    const panel = oneRule(launcher, '.launch-refine__panel')
    expect(panel).toMatch(/container-type:\s*inline-size/)
    expect(panel).toMatch(/container-name:\s*launch-refine/)
    const defaultRows = bodies(launcher, '.launch-refine__row').filter(body => body.includes('grid-template-columns:'))
    expect(defaultRows).toHaveLength(1)
    expect(defaultRows[0]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+156px/)
    const narrow = /@container\s+launch-refine\s*\(max-width:\s*320px\)\s*\{\s*\.launch-refine__row,\s*\.launch-refine__names\s*\{([^}]+)\}/.exec(launcher)
    expect(narrow, 'narrow fields must measure the Portal panel').not.toBeNull()
    expect(narrow![1]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/)
    expect(narrow!.index).toBeGreaterThan(launcher.indexOf('.launch-refine__row {'))
    expect(stylesheet('base.css')).not.toContain('.launch-refine__row')
    const source = readFileSync(new URL('../src/renderer/src/components/LaunchOptionControls.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/Dialog\.Portal[\s\S]*Dialog\.Content[^>]+className="launch-refine__panel"/)
    expect(source).toContain('className="launch-refine__row"')
  })

  it('owns message defaults with their final existing density instead of overriding them in Markdown', () => {
    const message = stylesheet('conversation-message.css')
    const markdown = stylesheet('markdown.css')
    expect(markdown).not.toMatch(/\.log-turn(?:__|(?=[^\w-]|$))/)
    expect(oneRule(message, '.log-turn__head')).toMatch(/gap:\s*var\(--sp-1\)\s+var\(--sp-2\)/)
    expect(oneRule(message, '.log-turn__body')).toMatch(/line-height:\s*1\.5\s*;/)
    const who = oneRule(message, '.log-turn__who')
    expect(who).toMatch(/flex:\s*1\s+1\s+140px/)
    expect(who).toMatch(/min-width:\s*min\(140px,\s*100%\)/)
    const continuation = oneRule(message, '.log-turn__continue')
    expect(continuation).toMatch(/font-size:\s*var\(--fs-micro\)/)
    expect(continuation).toMatch(/margin-top:\s*var\(--sp-2\)/)
    // Recent shared native-process delivery remains present; ownership is not a feature deletion.
    expect(message).toContain(".log-turn[data-message-bubble='true']")
    expect(message).toContain(".log-turn[data-trace-only='true']")
    expect(markdown).toContain('.md-paragraph')
  })

  it('uses the common micro-interaction and entry durations at actual consumer sites', () => {
    const styles = allStyleRules()
    expect(styles.length).toBeGreaterThan(100_000)
    for (const selector of ['.icon-button', '.icon-rotate-90', '.danger-button', '.log-fold__chevron', '.log-row__chevron', '.conversation-tool-trace__chevron']) {
      const found = bodies(styles, selector)
      expect(found.length).toBeGreaterThan(0)
      expect(found.filter(body => body.includes('var(--dur-fast)'))).toHaveLength(1)
      for (const body of found) expect(body).not.toMatch(/(?:^|[\s,])(?:\d*\.)?\d+(?:ms|s)\b/)
    }
    expect(oneRule(styles, '.animate-fade-in')).toContain('var(--dur-enter)')
    const caller = readFileSync(new URL('../src/renderer/src/components/workflow/WorkflowToolRow.tsx', import.meta.url), 'utf8')
    expect(caller).toContain('className="log-row__chevron"')
    const traceCaller = readFileSync(new URL('../../../packages/client-ui/src/components/ConversationToolTrace.tsx', import.meta.url), 'utf8')
    expect(traceCaller).toContain('conversation-tool-trace__chevron')
  })
})
