import type { CapacitorConfig } from '@capacitor/cli'
import { KeyboardResize } from '@capacitor/keyboard'

const config: CapacitorConfig = {
  appId: 'dev.bagakit.agentmux.mobile',
  appName: 'AgentMux',
  webDir: 'dist',
  backgroundColor: '#151b1b',
  server: { hostname: 'localhost', androidScheme: 'https', cleartext: false },
  ios: { contentInset: 'never' },
  plugins: { Keyboard: { resize: KeyboardResize.Native } }
}
export default config
