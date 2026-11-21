import { informationNativeFixture } from './agent-information-native.mjs'

/** Only the Provider observation port is controlled; scope, cache and publications are Core-owned. */
export async function modelStateOwnerFixture(core, directory, { mode = 'create', processId, initialObservation } = {}) {
  const observers = [], events = [], releases = new Set()
  let nativeSnapshot = initialObservation
  let observerReady
  const opening = new Promise(resolve => { observerReady = resolve })
  const fixture = await informationNativeFixture(core, directory, { mode, ...(processId ? { processId } : {}),
    ...(initialObservation ? { readConfigurationSnapshot: () => nativeSnapshot } : {}),
    async observeConfiguration(context, nativeSessionId) {
      const observer = { context, nativeSessionId, disposed: false }
      observers.push(observer); observerReady(observer)
      if (initialObservation) context.onConfiguration(structuredClone(initialObservation))
      return { dispose() { observer.disposed = true } }
    }
  })
  if (initialObservation) fixture.state.current = initialObservation.options.find(option => option.id === 'model')?.currentValue ?? fixture.state.current
  const release = fixture.client.onEvent(event => { if (event.type === 'agent-session') events.push(event.session) }, { observeMessages: false })
  function next(predicate) {
    return new Promise((resolve, reject) => {
      const release = fixture.client.onEvent(event => {
        if (event.type !== 'agent-session' || event.session.agentSessionId !== fixture.id || !predicate(event.session)) return
        stop(); resolve(event.session)
      }, { observeMessages: false })
      const timer = setTimeout(() => { stop(); reject(new Error('The expected semantic Session publication was not observed.')) }, 2000)
      const stop = () => { clearTimeout(timer); release(); releases.delete(stop) }
      releases.add(stop)
    })
  }
  function snapshot({ current = 'model-large', sequence = 1, sourceId = 'original-native-source', observedAt = 1000,
    nativeSessionId = fixture.nativeId, choices = ['model-small', 'model-large'] } = {}) {
    return { revision: 'revision-' + current, options: [{ id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: current, choices: choices.map(value => ({ value, name: value })) }],
    observation: { nativeSessionId, sourceId, sequence, observedAt, state: 'confirmed' } }
  }
  async function emit(value, observer = observers.at(-1)) {
    const published = next(session => session.nativeConfiguration?.observation?.state === 'confirmed' &&
      session.nativeConfiguration.observation.sequence === value.observation.sequence &&
      session.nativeConfiguration.observation.sourceId === value.observation.sourceId)
    if (value.observation.nativeSessionId === fixture.nativeId) fixture.state.current = value.options.find(option => option.id === 'model')?.currentValue ?? fixture.state.current
    if (initialObservation && value.observation.nativeSessionId === fixture.nativeId) nativeSnapshot = structuredClone(value)
    observer.context.onConfiguration(value)
    return await published
  }
  return { ...fixture, observers, events, next, snapshot, emit,
    async start() { const value = await fixture.client.inspectAgentConfiguration(fixture.input); await opening; return value },
    async close() { release(); for (const release of releases) release(); await fixture.close() } }
}
