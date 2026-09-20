// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { ComposerReferenceToolProps } from '../src/renderer/src/components/ComposerReferenceTool'

const presentation = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  return { replace: false }
})
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
// Replace only the shared presentation; both real hosts keep their API, insertion and draft owners.
vi.mock('../src/renderer/src/components/ComposerReferenceTool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/ComposerReferenceTool')>()
  return {
    ...actual,
    ComposerReferenceTool: (props: ComposerReferenceToolProps) => presentation.replace
      ? <button type="button" data-reference-presentation="replacement" disabled={props.disabled || !props.onSelect}
          onClick={props.onSelect} aria-label={props.label}>Browse files</button>
      : <actual.ComposerReferenceTool {...props} />
  }
})

import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => { presentation.replace = false })

for (const replace of [false, true]) {
  it.each(['session', 'launcher'] as const)(`${replace ? 'replacement' : 'production'} shared presentation reaches the real %s file picker and latest draft`, async (host) => {
    presentation.replace = replace
    const choose = vi.spyOn(api.ui, 'chooseFiles').mockResolvedValue(['/repo/first.ts', '/repo/second.ts'])
    const label = host === 'session' ? 'Reference files for the Agent to read' : 'Reference files for the Agent'
    if (host === 'session') {
      await dom.render(<AgentSessionComposer sessionId="agent-1" />)
      await dom.click('.composer-tool--mode')
    } else {
      useAppStore.setState({
        tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
        activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'Launch draft' }
      })
      await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
    }
    const tool = dom.container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
    expect(tool).not.toBeNull()
    expect(tool!.disabled).toBe(false)
    expect(tool!.textContent).toBe(replace ? 'Browse files' : 'Files')
    expect(tool!.hasAttribute('data-reference-presentation')).toBe(replace)
    await dom.click(`[aria-label="${label}"]`)
    expect(choose.mock.calls).toEqual([[{ defaultPath: '/repo' }]])
    const draft = dom.draft(host === 'session' ? 'agent-1' : 'region')
    expect(draft).toContain(host === 'session' ? 'Keep my draft' : 'Launch draft')
    expect(draft).toContain('@first.ts')
    expect(draft).toContain('@second.ts')
    expect(useAppStore.getState().error).toBeNull()
  })
}

it('the production leaf preserves its accessible name, 14px icon, disabled state and controlled callback', async () => {
  const { ComposerReferenceTool } = await vi.importActual<typeof import('../src/renderer/src/components/ComposerReferenceTool')>('../src/renderer/src/components/ComposerReferenceTool')
  const select = vi.fn()
  const label = 'Reference files for the Agent to read'
  await dom.render(<ComposerReferenceTool disabled={true} onSelect={select} label={label} />)
  const button = dom.container.querySelector<HTMLButtonElement>('button')!
  expect(button).not.toBeNull()
  expect(button.type).toBe('button')
  expect(button.title).toBe(label)
  expect(button.getAttribute('aria-label')).toBe(label)
  expect(button.querySelector('svg')?.getAttribute('width')).toBe('14')
  expect(button.querySelector('svg')?.getAttribute('height')).toBe('14')
  await dom.click('button')
  expect(select).not.toHaveBeenCalled()
  await dom.render(<ComposerReferenceTool disabled={false} onSelect={undefined} label={label} />)
  expect(dom.container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  await dom.render(<ComposerReferenceTool disabled={false} onSelect={select} label={label} />)
  await dom.click('button')
  expect(select).toHaveBeenCalledTimes(1)
})
