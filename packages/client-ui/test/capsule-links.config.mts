import base from './agent-link.config.mts'
export default { ...base, test: { ...base.test, include: ['packages/client-ui/test/capsule-links.test.tsx'] } }
