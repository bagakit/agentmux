import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
export const sha = value => createHash('sha256').update(value).digest('hex')
export const directorySourceFiles = [
  "apps/desktop/src/renderer/src/components/FocusDisconnectedProjects.tsx",
  "apps/desktop/src/renderer/src/components/FocusContextRow.tsx",
  "apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx",
  "apps/desktop/src/renderer/src/styles/focus.css",
  "docs/design/behavior/focus-context.md",
  "docs/design/presentation/focus-context.md",
  "apps/desktop/test/focus-offline-directory.test.tsx",
  "apps/desktop/test/focus-narrow-filters.test.tsx"
]
export const directorySourceBinding = root => Object.fromEntries(directorySourceFiles.map(file => [file, sha(readFileSync(path.join(root,file)))]))
