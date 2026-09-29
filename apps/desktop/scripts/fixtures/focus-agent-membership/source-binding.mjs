import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import path from 'node:path'
export const sourcePaths=['lib/focus-context.ts','components/GlobalFocusSurface.tsx','components/FocusNavigationPreview.tsx','components/FocusNavigationButton.tsx','components/FocusToolbar.tsx','store.ts','lib/agent-focus.ts','lib/focus-tab-projection.ts','components/SessionPane.tsx','components/WorkspaceWorkbench.tsx'].map(file=>'apps/desktop/src/renderer/src/'+file)
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export function sourceBinding(root){return Object.fromEntries([...sourcePaths,'apps/desktop/src/renderer/src/styles/focus.css'].map(file=>[file,sha(readFileSync(path.join(root,file)))]))}
