import { ICON_GLYPH_IDS, SEMANTIC_ICON_CATALOG, SEMANTIC_ICON_IDS } from './icon-catalog.js'

/** Product context belongs beside the semantic catalog, never in an individual client. */
const groups = {
  action: { label: 'Actions', description: 'Commands on controls, menus and work surfaces.' },
  status: { label: 'Status', description: 'Agent, connection, tool and operation status indicators.' },
  object: { label: 'Objects', description: 'Projects, resources and content types in lists and work surfaces.' },
  navigation: { label: 'Navigation', description: 'Movement through pages, history, links and content.' },
  layout: { label: 'Layout', description: 'Window, pane, tab and split arrangement controls.' },
  editor: { label: 'Editor', description: 'Code symbols, document formatting and editor tools.' },
  file: { label: 'Files', description: 'File types and resources in the explorer and editor.' },
  conversation: { label: 'Conversation', description: 'Messages, input, replies and conversation relationships.' },
  drawing: { label: 'Drawing', description: 'Canvas shapes, annotation and drawing tools.' },
  space: { label: 'Spaces', description: 'AgentMux spatial identities, positions and layout operations.' },
  toolkit: { label: 'Toolkit', description: 'Tool execution, versions, results and observation controls.' },
  control: { label: 'Controls', description: 'Shared checkboxes, selectors and keyboard hints.' },
  avatar: { label: 'Avatars', description: 'Product avatars and identity placeholders.' },
  appearance: { label: 'Appearance', description: 'Theme and brightness controls in appearance settings.' },
  git: { label: 'Git', description: 'Repository history, branches and working changes.' },
  note: { label: 'Notes', description: 'Notebook references and relationships in the note canvas.' },
} as const

const contexts: readonly [string, string][] = [
  ['status.toolkit-', 'Toolkit execution and result status.'],
  ['status.observation-', 'Resource observation status.'],
  ['status.connection-', 'Host connection status.'],
  ['status.presence-', 'Agent presence indicators.'],
  ['editor.symbol-', 'Code symbol lists and editor navigation.'],
  ['control.key-', 'Keyboard shortcut and completion hints.'],
]

/** One metadata projection for Settings and public discovery; defaults stay in the catalog. */
export function getSemanticIconCatalog() {
  return {
    groups: Object.entries(groups).map(([id, value]) => ({ id, ...value })),
    icons: SEMANTIC_ICON_IDS.map(id => {
      const groupId = id.split('.')[0] as keyof typeof groups
      const entry = SEMANTIC_ICON_CATALOG[id]
      const context = contexts.find(([prefix]) => id.startsWith(prefix))?.[1] ?? groups[groupId].description
      return { id, label: entry.label, description: `${entry.label}. ${context}`, groupId, defaultGlyph: entry.glyph }
    }),
    glyphs: [...ICON_GLYPH_IDS],
  }
}
