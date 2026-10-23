import { runIsolatedCapsuleMutations } from './isolated-mutation.mjs'
const mutations = [
  {
    name: 'observe the original input without replay',
    needle: 'this.options.replies!.inspect(structuredClone(prepared), ctx)',
    replacement: 'this.options.replies!.submit(structuredClone(prepared), ctx)',
    test: 'unknown reply submission',
  },
  {
    name: 'inspect the original reserved input before prepare',
    needle:
      'return parseCapsuleOperation({ ...operation, inputOperationId: saved.effect.inputOperationId })',
    replacement: 'return parseCapsuleOperation(operation)',
    test: 'trusted reply saves exact answer',
  },
]
await runIsolatedCapsuleMutations('src/node.ts', 'test/reply.test.mjs', mutations)
