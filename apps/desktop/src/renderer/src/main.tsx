import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installUnobservedFailureReporter } from './lib/unobserved-failure'
import { useAppStore } from './store'
import './styles.css'

// Installed before the first render so a failure during startup is reported too. This is the last
// resort behind each action's own catch, not a replacement for it: see lib/unobserved-failure.ts.
installUnobservedFailureReporter({
  host: window,
  reportError: (error: unknown) => useAppStore.getState().reportError(error)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
