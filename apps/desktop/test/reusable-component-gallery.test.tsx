// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createClientUiRoot } from './helpers/client-ui-render'
import { describe, expect, it, vi } from 'vitest'

// The gallery intentionally runs as the standalone web entry, not the Electron bridge.
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
import { WorkflowComponentGallery } from '../src/renderer/src/components/WorkflowComponentGallery.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

describe('Workflow component gallery production reachability', () => {
  it('uses the real reusable components for every reference state and scale fixture', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createClientUiRoot(container)
    try {
    await act(async () => { root.render(createElement(WorkflowComponentGallery)) })
    const markup = container.innerHTML
    for (const state of ['running', 'completed', 'failed', 'killed', 'paused']) {
      expect(markup).toContain(`data-status="${state}"`)
    }
    expect(markup).toContain('kb-eval-afs-question-gen')
    expect(markup).toContain('daemon 版本较旧，暂无阶段明细')
    expect(markup).toContain('wf-card--dock')
    expect(markup).toContain('aria-label="主题切换"')
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
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
    const sharedRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'client-ui', 'src')
    const read = (relative: string): string => readFileSync(join(sourceRoot, relative), 'utf8')
    const readShared = (relative: string): string => readFileSync(join(sharedRoot, relative), 'utf8')
    const activity = read('components/ActivityView.tsx')
    const sessionPane = read('components/SessionPane.tsx')
    const consumers = [
      ['ConversationAxis', read('components/ConversationReadingRuler.tsx')],
      ['CapturedConversationMessage', activity],
      ['ConversationMessage', readShared('components/CapturedConversationMessage.tsx')],
      ['ConversationMessage', read('components/ObservationSurfaceGallery.tsx')],
      ['MemoizedAgentMarkdown', readShared('components/ConversationReasoningTrace.tsx')],
      ['AgentInteractionCard', sessionPane],
      ['InlineComposer', readShared('components/ComposerCompletionEditor.tsx')],
      ['AgentComposer', read('components/AgentSessionComposer.tsx')],
      ['InlineRenameField', read('components/FileExplorer.tsx')],
      ['InlineRenameField', read('components/WorkflowComponentGallery.tsx')],
      ['StatusDot', read('components/ObservationSurfaceGallery.tsx')],
      ['ServiceWindowNotice', sessionPane]
    ]
    expect(consumers.length).toBeGreaterThan(0)
    for (const [name, text] of consumers) expect(text, `${name} has no production consumer`).toContain(`<${name}`)
    expect(read('components/workflow/index.ts')).not.toContain('ActivityView')
    expect(read('components/workflow/index.ts')).not.toContain('ConversationRuler')
    expect(activity).toContain("export { Ruler } from './ConversationRuler'")
    expect(read('components/workflow/index.ts')).toContain('WorkflowCard')
    expect(read('components/WorkflowComponentGallery.tsx')).toContain('<WorkflowCard')
  })
})
