import assert from 'node:assert/strict'

const owner = 'apps/desktop/src/main/toolkit-custom-owner.ts'
export const defaultShellMutations = {
  'mismatch-operation': [
    'packages/core/src/terminal-preparation.ts',
    'captured.createOperationId !== source.createOperationId ||',
    'false ||',
  ],
  'leak-receipt': [
    'apps/desktop/src/main/toolkit-receipt-store.ts',
    "catch { throw new AgentMuxError('Toolkit receipt storage is invalid.', 'CONTROL_PROTOCOL_ERROR') }",
    'catch (error) { throw error }',
  ],
  'reject-blank': [
    'packages/core/src/toolkit.ts',
    "code, partial || r.mode === 'tui')",
    'code, false)',
  ],
  'wrong-wrapper': [owner, '...(definition.script.trim()', '...(true'],
  'forget-prepared': [
    owner,
    'if (retained) {\n        if (!saved',
    'if (false) {\n        if (!saved',
  ],
  'remerge-environment': [
    'packages/core/src/ctxmux-run-adapter.ts',
    'this.requireClient().start(request, createOperationKey(operationKey))',
    'this.requireClient().start({ ...request, env: { ...request.env, ...localProcessEnvironment() } }, createOperationKey(operationKey))',
  ],
  'main-default': [
    'apps/desktop/src/main/runtime-controller.ts',
    'prepare: async input => await client.prepareTerminal(input)',
    "prepare: async input => await client.prepareTerminal({ ...input, command: input.command ?? process.env.SHELL ?? '/bin/sh' })",
  ],
}
export function mutateDefaultShell(source, path, mutation) {
  assert.ok(
    !mutation || Object.hasOwn(defaultShellMutations, mutation),
    'Mutation must name one default-shell product boundary',
  )
  const change = defaultShellMutations[mutation]
  if (!change || path !== change[0]) return source
  assert.equal(
    source.split(change[1]).length,
    2,
    'Mutation anchor must occur exactly once in loaded product source',
  )
  return source.replace(change[1], change[2])
}
