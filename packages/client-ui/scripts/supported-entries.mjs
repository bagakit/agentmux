import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const semanticIcons = './styles/semantic-icons.css'
const fieldStyles = './input/styles.css'
const actionStyles = './styles/buttons.css'

// Public names stay the same in the workspace and in a compiled distribution.
// Workspace-only entries remain in the package manifest until their consumers move.
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
  overlays: {
    entries: {
      './components/Modal': 'components/Modal.tsx',
      './components/HoverDropdownMenu': 'components/HoverDropdownMenu.tsx',
      './overlay-host': 'overlay-host.tsx'
    },
    styles: [fieldStyles, actionStyles, './styles/overlays.css']
  },
  feedback: {
    entries: { './components/InlineRenameField': 'components/InlineRenameField.tsx' },
    styles: [fieldStyles, semanticIcons, './styles/inline-rename-field.css']
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

export function supportedExportMap(target) {
  assert.ok(target === 'workspace' || target === 'distribution', 'Choose workspace or distribution exports')
  const distribution = target === 'distribution'
  const entries = {}
  for (const { entries: modules, styles } of Object.values(supportedExamples)) {
    for (const [entry, source] of Object.entries(modules)) {
      const module = source.replace(/\.tsx?$/, '.js')
      entries[entry] = distribution
        ? { types: './dist/' + module.replace(/\.js$/, '.d.ts'), import: './dist/' + module }
        : { types: './src/' + source, browser: './src/' + source, import: './dist/' + module }
    }
    for (const entry of styles) {
      const source = entry === fieldStyles ? 'input/input.css' : entry.slice(2)
      entries[entry] = (distribution ? './dist/' : './src/') + source
    }
  }
  return entries
}

export function verifyWorkspaceExportMap(exports) {
  assert.ok(Object.keys(exports).length > 0, 'Workspace export set cannot be empty')
  for (const [name, expected] of Object.entries(supportedExportMap('workspace'))) {
    assert.deepEqual(exports[name], expected, 'Missing or different exact export ' + name)
  }
}

async function updateWorkspaceExports(write) {
  const file = new URL('../package.json', import.meta.url)
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  if (!write) { verifyWorkspaceExportMap(manifest.exports); return }
  manifest.exports = { ...manifest.exports, ...supportedExportMap('workspace') }
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  assert.ok(mode === '--write' || mode === '--check', 'Choose --write or --check')
  await updateWorkspaceExports(mode === '--write')
}
