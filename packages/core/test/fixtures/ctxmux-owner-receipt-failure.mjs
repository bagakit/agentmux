import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'

// Block only the actual instance/artifact receipt selected by the production
// publisher. The new daemon identity is deliberately not guessed in advance.
const originalRename = fs.rename
fs.rename = async (source, target) => {
  if (String(target).includes('/owner-') && String(target).endsWith('.json')) await fs.mkdir(target, { recursive: true })
  return await originalRename(source, target)
}
syncBuiltinESMExports()
