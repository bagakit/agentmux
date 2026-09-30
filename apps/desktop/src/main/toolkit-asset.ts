import { app } from 'electron'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ToolkitScript } from '@agentmux/core/control'
export type PerformanceLaunch = { runner: string; cli: string; script: string; cwd: string; env: Record<string,string> }
export function performanceLaunch(): PerformanceLaunch {
  const root = app.getAppPath()
  return { runner: process.execPath,
    cli: app.isPackaged ? join(root, 'node_modules/@agentmux/core/dist/agentmux.js') : resolve(root, '../../packages/core/dist/agentmux.js'),
    script: join(root, 'resources/toolkit/performance.mjs'),
    cwd: app.getPath('userData'), env: { ELECTRON_RUN_AS_NODE: '1' } }
}
export async function readPerformanceScript(launch: PerformanceLaunch): Promise<ToolkitScript> {
  const bytes = await readFile(launch.script)
  return { toolId: 'performance', path: launch.script, sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') }
}
