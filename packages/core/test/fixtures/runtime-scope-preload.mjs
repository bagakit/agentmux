const testUid = process.env.AGENTMUX_TEST_UID

if (!testUid || !/^t[0-9]+-[0-9a-f]{8}$/u.test(testUid)) {
  throw new Error('Packed consumer test requires a bounded synthetic uid.')
}

Object.defineProperty(process, 'getuid', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: () => testUid
})
