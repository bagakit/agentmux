export const packageIdentifierMutations = [
  { name: 'enrollment-store-uuid', path: 'packages/connectors/src/connection-enrollment-store.ts', pattern: 'uses compiled CLI and original SDK through the Desktop owner' },
  { name: 'enrollment-create-wire-format', path: 'packages/connectors/src/connection-enrollment-store.ts', pattern: 'retains the original native creation rejection through durable inspect', before: "kind === 'create' ? randomUUID() : mintObjectId()", after: 'mintObjectId()' },
  { name: 'enrollment-owner-uuid', path: 'packages/connectors/src/connection-enrollment.ts', pattern: 'uses compiled CLI and original SDK through the Desktop owner' },
  { name: 'setup-uuid', path: 'packages/connectors/src/connection-setup.ts', pattern: 'compiled CLI and SDK explicitly inspect the exact saved application' },
  { name: 'configuration-step-uuid', path: 'packages/connectors/src/connection-setup-configuration.ts', pattern: 'SDK and compiled CLI explicitly enable one exact original bot' },
  { name: 'inspection-step-uuid', path: 'packages/connectors/src/connection-setup-inspection.ts', pattern: 'compiled CLI and SDK explicitly inspect the exact saved application' },
  { name: 'ingress-identities-uuid', path: 'packages/connectors/src/durable-ingress.ts', pattern: 'original external ingress freezes shared IDs through Core journal and public inspection' },
  { name: 'permission-reference-uuid', path: 'packages/connectors/src/permission-actions.ts', pattern: 'authenticates the SDK callback, commits before ACK' },
  { name: 'room-attempt-uuid', path: 'packages/connectors/src/room-provisioning-store.ts', pattern: 'compiled room CLI and typed public SDK reach' },
  { name: 'demand-operation-uuid', path: 'packages/demand/src/demand-store.ts', pattern: 'Demand writes use shared temporary and operation IDs' },
  { name: 'demand-cli-request-uuid', path: 'packages/demand/src/cli.ts', pattern: 'compiled Demand CLI emits shared request and operation IDs' },
  { name: 'relay-pair-uuid', path: 'packages/relay/src/local-adapter.ts', pattern: 'local Relay allocates a shared pair ID' },
  { name: 'demand-replace-original-operation', path: 'packages/demand/src/demand-store.ts', pattern: 'Demand writes use shared temporary and operation IDs', before: 'titleAttempt?.operationId ?? requestedOperationId ?? mintObjectId()', after: 'mintObjectId()' },
  { name: 'relay-pair-is-authority', path: 'packages/relay/src/local-adapter.ts', pattern: 'local Relay allocates a shared pair ID', before: "role === 'server' && (!loopback || request.headers.authorization !== `Bearer ${controlToken}`)", after: "role === 'server' && !loopback" }
]
export function mutatePackageIdentifiers(code, mutation) {
  if (!mutation.before) {
    if (!code.includes('mintObjectId()')) throw Error('Missing allocator mutation anchor: ' + mutation.name)
    return code.replaceAll('mintObjectId()', 'globalThis.crypto.randomUUID()')
  }
  if (code.split(mutation.before).length !== 2) throw Error('Missing or ambiguous mutation anchor: ' + mutation.name)
  return code.replace(mutation.before, mutation.after)
}
