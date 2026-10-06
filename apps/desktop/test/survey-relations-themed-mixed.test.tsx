// @vitest-environment happy-dom
import { act } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { SurveyTopicRelations } from '../src/renderer/src/components/SurveyTopicRelations'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
const dom = composerDOM(); let cleanup: () => void
beforeEach(() => { cleanup = mountThemeRuntime(window) }); afterEach(() => cleanup())
it('shows unknown relationship as disabled mixed selection, independently themeable from collapse and selected', async () => {
  const link = vi.fn(), open = vi.fn(), workspace = composerConfig.workspaces[0]!
  const topic = { spaceId: 'original-space', topicId: 'original-topic', kind: 'topic' as const, name: 'Original topic', hostId: workspace.hostId, directoryPath: workspace.path, projectId: workspace.id }
  await dom.render(<Menu.Root open><Menu.Trigger>Original relationships</Menu.Trigger><Menu.Content forceMount><SurveyTopicRelations zone={{ zoneId: 'original-zone', workspaceId: workspace.id, kind: 'directory', hostId: workspace.hostId, directoryPath: workspace.path, branch: null }} topics={[topic]} relatedTopics={null} pendingSpaceId={null} onLinkChange={link} onOpenTopic={open}/></Menu.Content></Menu.Root>)
  const item = document.querySelector<HTMLElement>('[data-survey-topic-id="original-space"]')!
  expect(item, 'actual mixed relationship consumer').not.toBeNull()
  expect(item.getAttribute('aria-checked')).toBe('mixed'); expect(item.getAttribute('data-disabled')).not.toBeNull()
  expect(item.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('control.checkbox-mixed'))
  const symbol = document.getElementById(semanticIconHref('control.checkbox-mixed').slice(1))!
  expect(symbol.querySelector('path[d="M5 12h14"]')).not.toBeNull()
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.mixed-proof'; custom.name = 'Mixed selection'
  custom.icons = { 'control.checkbox-mixed': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true); item.click() })
  expect(document.querySelector('[data-survey-topic-id="original-space"]')).toBe(item)
  expect(document.getElementById(semanticIconHref('control.checkbox-mixed').slice(1))!.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(item.getAttribute('aria-checked')).toBe('mixed'); expect(item.getAttribute('data-disabled')).not.toBeNull()
  expect(link).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
})
