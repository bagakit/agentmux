import { accessSync, constants, lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AgentMuxRpcCertificatePreparation } from '@agentmux/core'

/** Only the helper delivered beside this Host, never a client-selected executable. */
export function readCertificatePreparation(): AgentMuxRpcCertificatePreparation | undefined {
  const executable = process.execPath, entry = join(import.meta.dirname, 'prepare-private-access.js')
  const valid = (path: string) => path.length > 0 && Buffer.byteLength(path, 'utf8') <= 4096 && isAbsolute(path)
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(path)
  if (!valid(executable) || !valid(entry)) return undefined
  try {
    const artifact = lstatSync(entry)
    if (!artifact.isFile() || artifact.isSymbolicLink() || artifact.size < 1 || !lstatSync(executable).isFile()) return undefined
    accessSync(entry, constants.R_OK); accessSync(executable, constants.X_OK)
    return { executable, entry, electronRunAsNode: typeof process.versions.electron === 'string' }
  } catch {
    // A missing delivery helper affects the preparation link only. It says nothing
    // about the existing HTTPS listener, device authority or original healthy Run.
    return undefined
  }
}
