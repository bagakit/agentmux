import { runIsolatedCapsuleMutations } from './isolated-mutation.mjs'
const mutations = [
  {
    name: 'stable loopback origin',
    needle: "this.server.listen(this.record.port, '127.0.0.1')",
    replacement: "this.server.listen(0, '127.0.0.1')",
    test: 'real process death',
  },
  {
    name: 'loaded HTTP instance provenance',
    needle: "res.setHeader('X-AgentMux-Capsule-Instance', this.instanceId)",
    replacement: "res.setHeader('X-AgentMux-Capsule-Instance', 'foreign-instance')",
    test: 'actual successful HTTP responses',
  },
]
await runIsolatedCapsuleMutations('src/http.ts', 'test/owner.test.mjs', mutations)
