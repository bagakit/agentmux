globalThis.fixtureEvents = []
for (const type of ['click', 'input', 'wheel', 'keydown']) {
  document.addEventListener(type, event => {
    fixtureEvents.push({ type, target: event.target.id ?? '', trusted: event.isTrusted, at: Date.now(),
      key: type === 'keydown' && ['Enter', 'Tab', 'Escape', 'Meta+Enter'].includes(event.key) ? event.key : undefined,
      modifiers: type === 'keydown' ? { ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey, shift: event.shiftKey } : undefined })
    if (type === 'click' && event.target.id === 'target') {
      const prior = Number(localStorage.getItem('proofClicks') ?? 0)
      localStorage.setItem('proofClicks', String(prior + 1))
      document.querySelector('#result').textContent = 'Page action completed'
    }
  })
}

// A genuine finite page job for the running scene; ordinary single actions remain separate.
globalThis.performFixtureWork = async () => {
  globalThis.fixtureWork = { phase: 'working', stage: 'reading', startedAt: Date.now(), inputBytes: 0, digests: 0 }
  document.querySelector('#result').textContent = 'Reading page work'
  const response = await fetch('/work.bin')
  if (!response.ok) throw new Error('Private page work input could not be read')
  const bytes = await response.arrayBuffer()
  Object.assign(globalThis.fixtureWork, { stage: 'checking', inputBytes: bytes.byteLength })
  document.querySelector('#result').textContent = 'Reading and checking page work'
  let hash
  for (let i = 0; i < 256; i++) {
    hash = await crypto.subtle.digest('SHA-256', bytes)
    fixtureWork.digests++
  }
  fixtureWork.phase = 'completed'; fixtureWork.finishedAt = Date.now()
  fixtureWork.outputBytes = hash.byteLength
  document.querySelector('#result').textContent = 'Page work checked'
  return { ...fixtureWork }
}

// Actual page lifecycle facts distinguish setup/scroll clear from completion expiry.
for (const type of ['scroll', 'resize', 'visibilitychange']) {
  const owner = type === 'visibilitychange' ? document : window
  owner.addEventListener(type, event => fixtureEvents.push({ type, trusted: event.isTrusted, at: Date.now(), scrollX, scrollY, width: innerWidth, height: innerHeight, visibility: document.visibilityState }))
}
