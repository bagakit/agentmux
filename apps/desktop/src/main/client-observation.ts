import { readFile } from 'node:fs/promises'
import { AgentMuxError, type AgentMuxControlRequest, type AgentMuxControlResult } from '@agentmux/core'
import {
  desktopPackageIdentitySchema, desktopWorkbenchObservationSchema,
  parseDesktopClientObservation, type DesktopLoadedRenderer, type DesktopPackageIdentity,
  type DesktopClientObservation
} from '../shared/client-observation.js'

/** Capture at Main startup. Missing metadata stays unknown; it is never reread during observation. */
export async function readLoadedPackageIdentity(path: string): Promise<DesktopPackageIdentity | null> {
  try { return Object.freeze(desktopPackageIdentitySchema.parse(JSON.parse(await readFile(path, 'utf8')))) }
  catch { return null }
}

/** One existing IPC request, bound to the same successful loader and navigation owner. */
export async function inspectDesktopClient(request: AgentMuxControlRequest, owner: {
  pid: number
  package: DesktopPackageIdentity | null
  renderer(): DesktopLoadedRenderer | null
  generation(): number | null
  storage?(): Promise<DesktopClientObservation['main']['storage']>
  runtimes(): DesktopClientObservation['main']['runtimes']
  execute(request: AgentMuxControlRequest): Promise<AgentMuxControlResult>
}): Promise<AgentMuxControlResult> {
  const renderer = owner.renderer()
  const generation = owner.generation()
  if (!renderer || generation === null) throw new AgentMuxError('Loaded Desktop owner is unavailable.', 'CONTROL_UNAVAILABLE')
  // Storage qualification is local. A failed observation cannot hide the original workbench.
  const [result, storage] = await Promise.all([owner.execute(request), Promise.resolve().then(() => owner.storage?.()).catch(() => undefined)])
  if (owner.renderer() !== renderer || owner.generation() !== generation) {
    throw new AgentMuxError('Desktop navigated while its workbench was being observed.', 'CONTROL_UNAVAILABLE')
  }
  if (result.operation !== 'inspect.client') throw new AgentMuxError('Desktop returned an unexpected operation.', 'CONTROL_PROTOCOL_ERROR')
  const workbench = desktopWorkbenchObservationSchema.parse(result.observation)
  const observation = parseDesktopClientObservation({
    schema: 'agentmux.desktop-client-observation.v1',
    main: { pid: owner.pid, package: owner.package, renderer, runtimes: owner.runtimes(), ...(storage ? { storage } : {}) }, workbench
  })
  return { operation: 'inspect.client', observation }
}
