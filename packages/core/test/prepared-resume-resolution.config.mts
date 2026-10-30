import base from './durable-direct-resume.config.mts'
export default { ...base, test: { ...base.test, include: ['packages/core/test/prepared-resume-resolution.test.ts'], passWithNoTests: false } }
