import { createRequire } from 'node:module'

// Dialog and Menu must share dismissal and focus stacks. Their installed dependency
// versions can differ, so workspace and archive builds use Dialog's primitive owners.
const dialog = createRequire(createRequire(new URL('../package.json', import.meta.url)).resolve('@radix-ui/react-dialog'))
export const radixOverlayAliases: Record<string, string> = Object.fromEntries(
  ['@radix-ui/react-dismissable-layer', '@radix-ui/react-focus-scope'].map(name => [name, dialog.resolve(name)])
)
