import { registerPlugin } from '@capacitor/core'
import { getDeviceWorkface } from '../../recovery/device-workface'

export interface NativeWorkfaceFilePlugin {
  save(input: { filename: 'agentmux-workface.json'; bytes: string }): Promise<void>
}
const native = registerPlugin<NativeWorkfaceFilePlugin>('AgentMuxWorkfaceFile')

/** Public workface only. A cancelled picker or failed write never becomes a save receipt. */
export async function exportNativeWorkfaceFile(filename: string, bytes: string,
  plugin: NativeWorkfaceFilePlugin = native): Promise<void> {
  if (filename !== 'agentmux-workface.json') throw new Error('工作面只能保存为 agentmux-workface.json。此次尚未保存。')
  getDeviceWorkface().parseBackup(bytes)
  await plugin.save({ filename, bytes })
}
