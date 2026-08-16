import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkflowComponentGallery } from '../src/renderer/src/components/WorkflowComponentGallery.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

describe('Workflow component gallery production reachability', () => {
  it('uses the real reusable components for every reference state and scale fixture', () => {
    const markup = renderToStaticMarkup(createElement(WorkflowComponentGallery))
    for (const state of ['running', 'completed', 'failed', 'killed', 'paused']) {
      expect(markup).toContain(`data-status="${state}"`)
    }
    expect(markup).toContain('kb-eval-afs-question-gen')
    expect(markup).toContain('daemon 版本较旧，暂无阶段明细')
    expect(markup).toContain('wf-card--dock')
    expect(markup).toContain('aria-label="主题切换"')
  })

  it('keeps the desktop query preview and standalone deployment entry explicit', () => {
    const appPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'App.tsx')
    const source = readFileSync(appPath, 'utf8')
    expect(source).toContain('agentmux-component-gallery')
    expect(source).toContain('<WorkflowComponentGallery />')
    const htmlPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'gallery.html')
    expect(readFileSync(htmlPath, 'utf8')).toContain('src/gallery-main.tsx')
  })

  it('keeps the standalone gallery as the deployment entry while the desktop query remains a local preview', () => {
    const htmlPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'gallery.html')
    const entryPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'gallery-main.tsx')
    expect(readFileSync(htmlPath, 'utf8')).toContain('src/gallery-main.tsx')
    expect(readFileSync(entryPath, 'utf8')).toContain('<WorkflowComponentGallery />')
  })

  it('records real production consumers for existing chat primitives and keeps Activity internals private', () => {
    const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src')
    const read = (relative: string): string => readFileSync(join(sourceRoot, relative), 'utf8')
    const activity = read('components/ActivityView.tsx')
    const sessionPane = read('components/SessionPane.tsx')
    const consumers = [
      ['ConversationAxis', activity],
      ['AgentMarkdown', activity],
      ['AgentInteractionCard', sessionPane],
      ['ComposerTextarea', read('components/AgentComposer.tsx')],
      ['StatusDot', read('components/SurfaceToolDock.tsx')],
      ['ServiceWindowNotice', sessionPane]
    ]
    expect(consumers.length).toBeGreaterThan(0)
    for (const [name, text] of consumers) expect(text, `${name} has no production consumer`).toContain(`<${name}`)
    expect(activity).toContain('function Row(')
    expect(activity).toContain('function Run(')
    expect(activity).toContain('function Turn(')
    expect(activity).toContain('export function Ruler(')
    expect(read('components/workflow/index.ts')).toContain('WorkflowCard')
    expect(read('components/WorkflowComponentGallery.tsx')).toContain('<WorkflowCard')
  })
})
