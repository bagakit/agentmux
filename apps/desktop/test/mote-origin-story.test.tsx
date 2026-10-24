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
  expect([...story.querySelectorAll('.mote-origin__path > small')].map(node => node.textContent)).toEqual(['画像创建', '从事情成长'])
  const buttons = [...story.querySelectorAll<HTMLButtonElement>('button')]
  expect(buttons).toHaveLength(3)
  expect(buttons.every(button => button.type === 'button' && button.getAttribute('aria-controls'))).toBe(true)
  expect(story.querySelector('h4')?.textContent).toBe('带着专长，开始合作。')
  const images = new Set<string>()
  images.add(story.querySelector('img')!.src)
  await dom.click('[aria-label="40px avatar"]')
  await dom.click('input[name="mote-directory-view"][value="list"]')
  await dom.click('.mote-origin__path:nth-child(2) button:first-of-type')
  expect(story.querySelector('h4')?.textContent).toBe('从每天一起做的一件事开始。')
  expect(story.querySelector('figcaption')?.textContent).toContain('Topic')
  expect(story.querySelector('img')?.alt).toContain('三位 Agent')
  images.add(story.querySelector('img')!.src)
  await dom.click('.mote-origin__path:nth-child(2) button:last-of-type')
  expect(story.querySelector('h4')?.textContent).toBe('让重要的方向，成为长期伙伴。')
  expect(story.querySelector('.mote-origin__eyebrow')?.textContent).toContain('晋升构想')
  expect(story.textContent).toContain('原来的 Agent 与积累一起延续')
  expect(story.querySelector('img')?.alt).toContain('相同的三位 Agent')
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
