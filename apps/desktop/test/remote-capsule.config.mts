import base from './capsule-main.config.mts'
export default { ...base, test: { ...base.test, include: ['apps/desktop/test/remote-capsule.test.ts'], environment: 'node', testTimeout: 20000 } }
