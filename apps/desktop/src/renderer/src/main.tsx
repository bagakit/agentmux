import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installUnobservedFailureReporter } from './lib/unobserved-failure'
import { installFileDropGuard } from './lib/file-drop-guard'
import { prepareRendererUpdate, useAppStore } from './store'
import './styles/index.css'

// Installed before the first render so a failure during startup is reported too. This is the last
// resort behind each action's own catch, not a replacement for it: see lib/unobserved-failure.ts.
installUnobservedFailureReporter({
  host: window,
  reportError: (error: unknown) => useAppStore.getState().reportError(error)
})

// 拦掉「往窗口拖入文件」触发的原生 file:/// 导航——那会让拖入的恶意文档继承 preload 的特权桥。这是
// 渲染层的「不发起」，主进程 index.ts 的 will-navigate 闸是「就算发起也拦下」的后盾。见 lib/file-drop-guard.ts。
installFileDropGuard(window)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// Main invokes this bounded checkpoint before a controlled presentation reload. No Run state crosses it.
Object.assign(window, { agentmuxPrepareRendererUpdate: prepareRendererUpdate })

window.addEventListener('agentmux-renderer-update-error', (event) => useAppStore.getState().reportError((event as CustomEvent).detail))
