import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspaceAssets, workspaceSources } from './workspace-entries.mjs'

const semanticIcons = './styles/semantic-icons.css'
const fieldStyles = './input/styles.css'
const actionStyles = './styles/buttons.css'

// Public names stay the same in the workspace and in a compiled distribution.
// Shared workspace domain entries are defined in workspace-entries.mjs.
export const supportedExamples = {
  actions: {
    entries: {
      './components/Button': 'components/Button.tsx',
      './components/IconButton': 'components/IconButton.tsx'
    },
    styles: [actionStyles]
  },
  fields: {
    entries: {
      './input': 'input/index.ts',
      './components/FormRow': 'components/FormRow.tsx'
    },
    styles: [fieldStyles]
  },
  selection: {
    entries: {
      './components/Tabs': 'components/Tabs.tsx',
      './components/SegmentedControl': 'components/SegmentedControl.tsx'
    },
    styles: ['./styles/segmented-control.css']
  },
  overlays: {
    entries: {
      './components/Modal': 'components/Modal.tsx',
      './components/DropdownMenu': 'components/DropdownMenu.tsx',
      './components/HoverDropdownMenu': 'components/HoverDropdownMenu.tsx',
      './overlay-host': 'overlay-host.tsx'
    },
    styles: [fieldStyles, actionStyles, './styles/overlays.css']
  },
  feedback: {
    entries: {
      './components/ActionFeedback': 'components/ActionFeedback.tsx',
      './components/InlineRenameField': 'components/InlineRenameField.tsx'
    },
    styles: [fieldStyles, actionStyles, semanticIcons, './styles/inline-rename-field.css']
  },
  locations: {
    entries: { './patterns/agent-work-location': 'patterns/agent-work-location.tsx' },
    styles: [semanticIcons, './patterns/agent-work-location.css']
  },
  theme: {
    entries: {
      './theme': 'theme/index.ts',
      './theme/model': 'theme/model.ts',
      './icons': 'theme/icons.tsx'
    },
    styles: [semanticIcons, './styles/palette.css', './styles/theme-defaults.css']
  }
}

export const standalonePatternDocs = [
  'docs/patterns/agent-work-location.md',
  'docs/patterns/read-while-work-continues.md',
  'docs/patterns/interaction-receipts.md',
]

function moduleExport(source, distribution) {
  const module = source.replace(/\.tsx?$/, '.js')
  if (distribution) return { types: './dist/' + module.replace(/\.js$/, '.d.ts'), import: './dist/' + module }
  return { types: './src/' + source, browser: './src/' + source, import: './dist/' + module }
}

export function supportedExportMap(target) {
  assert.ok(target === 'workspace' || target === 'distribution', 'Choose workspace or distribution exports')
  const distribution = target === 'distribution'
  const entries = {}
  for (const { entries: modules, styles } of Object.values(supportedExamples)) {
    for (const [entry, source] of Object.entries(modules)) {
      entries[entry] = moduleExport(source, distribution)
    }
    for (const entry of styles) {
      const source = entry === fieldStyles ? 'input/input.css' : entry.slice(2)
      entries[entry] = (distribution ? './dist/' : './src/') + source
    }
  }
  return entries
}

export function workspaceExportMap() {
  const entries = { ...workspaceAssets, ...supportedExportMap('workspace') }
  for (const [name, source] of Object.entries(workspaceSources)) {
    assert.ok(!Object.hasOwn(entries, name), 'Entry already has an owner ' + name)
    entries[name] = source.endsWith('.css') ? './src/' + source : moduleExport(source, false)
  }
  return entries
}

export function verifyWorkspaceExportMap(exports) {
  assert.ok(Object.keys(exports).length > 0, 'Workspace export set cannot be empty')
  const expected = workspaceExportMap()
  for (const [name, value] of Object.entries(expected)) {
    assert.deepEqual(exports[name], value, 'Missing or different exact export ' + name)
    if (typeof value === 'object') {
      assert.deepEqual(Object.keys(exports[name]), Object.keys(value), 'Export conditions must keep their order ' + name)
    }
  }
  assert.deepEqual(Object.keys(exports).filter(name => !Object.hasOwn(expected, name)), [], 'Unregistered workspace exports')
}

async function updateWorkspaceExports(write) {
  const file = new URL('../package.json', import.meta.url)
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  assert.ok(!Object.hasOwn(manifest, 'main') && !Object.hasOwn(manifest, 'types'), 'Use the named Client UI exports')
  if (!write) { verifyWorkspaceExportMap(manifest.exports); return }
  manifest.exports = workspaceExportMap()
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  assert.ok(mode === '--write' || mode === '--check', 'Choose --write or --check')
  await updateWorkspaceExports(mode === '--write')
}
