import { fileURLToPath } from 'node:url'

export { startCapsuleRuntime, type CapsuleRuntimeServer } from './runtime-server.js'
export {
  connectCapsuleRuntime,
  type CapsuleRuntimeAdapters,
  type CapsuleRuntimeClient,
} from './runtime-client.js'
export { parseCapsuleRuntimeIdentity, type CapsuleRuntimeIdentity } from './runtime-wire.js'

/** Resolve the installed, compiled entry without a checkout, shell or Desktop dependency. */
export function capsuleRuntimeEntrypoint(): string {
  return fileURLToPath(new URL('./runtime-cli.js', import.meta.url))
}
