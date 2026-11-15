const buildId = process.env.MOBILE_TEST_BUILD_ID
if (buildId && typeof document !== 'undefined') {
  const meta = document.createElement('meta')
  meta.name = 'agentmux-mobile-build'
  meta.content = buildId
  document.head.append(meta)
}
