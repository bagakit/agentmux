import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
export const sha=value=>createHash('sha256').update(value).digest('hex')
export const chatSourceFiles=[
 'apps/desktop/src/renderer/src/components/FocusToolbar.tsx',
 'apps/desktop/src/renderer/src/lib/pmo-teams-topic-floating.ts',
 'apps/desktop/src/renderer/src/styles/focus.css',
 'docs/design/behavior/focus-context.md',
 'docs/design/presentation/focus-context.md',
 'apps/desktop/test/focus-chat-mote.test.tsx',
 'apps/desktop/test/fixtures/mote-workface.ts',
 'apps/desktop/test/pmo-teams-topic-floating-contract.test.ts'
]
export const chatSourceBinding=root=>Object.fromEntries(chatSourceFiles.map(file=>[file,sha(readFileSync(path.join(root,file)))]))
