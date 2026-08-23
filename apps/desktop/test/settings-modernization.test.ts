import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panel = readFileSync(new URL('../src/renderer/src/components/SettingsPanel.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/renderer/src/styles/surfaces.css', import.meta.url), 'utf8')

describe('settings workbench shell', () => {
  it('keeps a contextual header and a close action in the main work area', () => {
    expect(panel).toContain('settings-content__header')
    expect(panel).toContain('settings-content__title')
    expect(panel).toContain('settings-content__close')
    expect(panel).toContain('onClick={onClose}')
    expect(panel).toContain('settings-sidebar__context')
    expect(panel).toContain('settings-content__breadcrumb')
    expect(panel).toContain('settings-content__actions')
  })

  it('has tokenized responsive rules for narrow settings windows', () => {
    expect(styles).toContain('@media (max-width: 560px)')
    expect(styles).toContain('.settings-sidebar nav { display: flex;')
    expect(styles).toContain('.settings-content__icon')
    expect(styles).toContain('.settings-content__hint')
    expect(styles).toContain('.settings-sidebar__context')
    expect(styles).not.toContain('background: #')
  })
})
