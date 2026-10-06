import type { AgentMuxControlThemeIconCatalog } from '../../src/control.js'

/** Deliberately independent of any UI library, product semantic enum or default glyph set. */
export function settingsIconCatalogFixture(): AgentMuxControlThemeIconCatalog {
  return {
    groups: [{ id: 'portable', label: 'Portable meanings', description: 'A client-owned category.' }],
    icons: [
      { id: 'arbitrary.first', label: '第一个含义', description: 'First client-owned meaning.', groupId: 'portable', defaultGlyph: 'drawing-a' },
      { id: 'arbitrary.second', label: 'Second meaning', description: 'Separate meanings may share one drawing.', groupId: 'portable', defaultGlyph: 'drawing-a' }
    ],
    glyphs: ['drawing-a', 'drawing-b']
  }
}
