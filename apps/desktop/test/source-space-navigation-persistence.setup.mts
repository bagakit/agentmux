import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export default function setup(): void {
  const root=resolve(import.meta.dirname,'../../..'),installedRoot=root.includes('/.worktrees/')?resolve(root,'../..'):root
  if(process.env.AGENTMUX_SOURCE_NAV_SKIP_BUILD!=='1')execFileSync(process.execPath,[resolve(installedRoot,'apps/desktop/node_modules/electron-vite/bin/electron-vite.js'),'build'],{cwd:resolve(root,'apps/desktop'),stdio:'inherit',env:{...process.env,NODE_OPTIONS:'--max-old-space-size=8192'}})
}
