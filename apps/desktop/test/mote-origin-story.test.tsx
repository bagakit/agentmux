// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()

it('the real Mote settings teaches two origins with member Agents and keeps its unsaved preferences while changing scenes', async () => {
  const save = vi.spyOn(api.config, 'save').mockImplementation(async next => next)
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="mote" />)
  const story = dom.container.querySelector('.mote-origin')!
  expect(story, 'The production settings must consume the story').not.toBeNull()
  expect([...story.querySelectorAll('.mote-origin__path > small')].map(node => node.textContent)).toEqual(['From a profile', 'Grow from the work'])
  const buttons = [...story.querySelectorAll<HTMLButtonElement>('button')]
  expect(buttons).toHaveLength(3)
  expect(buttons.every(button => button.type === 'button' && button.getAttribute('aria-controls'))).toBe(true)
  expect(story.querySelector('h4')?.textContent).toBe('Bring your specialties together.')
  const images = new Set<string>()
  images.add(story.querySelector('img')!.src)
  await dom.click('[aria-label="40px avatar"]')
  await dom.click('input[name="mote-directory-view"][value="list"]')
  await dom.click('.mote-origin__path:nth-child(2) button:first-of-type')
  expect(story.querySelector('h4')?.textContent).toBe('Start with something you work on together.')
  expect(story.querySelector('figcaption')?.textContent).toContain('Topic')
  expect(story.querySelector('img')?.alt).toContain('Three Agents')
  images.add(story.querySelector('img')!.src)
  await dom.click('.mote-origin__path:nth-child(2) button:last-of-type')
  expect(story.querySelector('h4')?.textContent).toBe('Let important work become a lasting collaborator.')
  expect(story.querySelector('.mote-origin__eyebrow')?.textContent).toBe('Grow from the work · Promotion')
  expect(story.textContent).toContain('Keep the same Agents and their accumulated work.')
  expect(story.querySelector('img')?.alt).toContain('The same three Agents')
  images.add(story.querySelector('img')!.src)
  expect(images.size).toBe(3)
  expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Avatar size"]')?.value).toBe('40')
  expect(dom.container.querySelector<HTMLInputElement>('input[value="list"]')?.checked).toBe(true)
  expect(save).not.toHaveBeenCalled()
  await dom.click('[data-settings-pane="mote"] [data-settings-save-bar] button')
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]?.[0]).toMatchObject({ moteDirectoryView: 'list', moteDirectoryAvatarSize: 40 })
  expect(save.mock.calls[0]?.[1]).toMatchObject({ moteDirectoryView: 'collaborators', moteDirectoryAvatarSize: 45 })
})
