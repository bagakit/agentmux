import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
import sourceOwner from './manual-connection-owner.config.mts'
const mutant = process.env.TELEGRAM_SETTINGS_MUTANT
if (mutant && mutant !== 'platform-isolation') throw Error('Unknown Telegram Settings mutant')
export default defineConfig({ ...sourceOwner, define: original.define, plugins: [...sourceOwner.plugins!, {
  name: 'telegram-settings-platform-isolation', enforce: 'pre', transform(source, id) {
    if (!mutant || !id.endsWith('/components/settings/ExternalConnectionsSettings.tsx')) return
    const anchor = "result.connections.filter(record => record.config.adapterId === (channel === 'lark' ? 'feishu' : channel))"
    if (source.split(anchor).length !== 2) throw Error('Telegram Settings mutant anchor must be unique')
    return "console.error('TELEGRAM_SETTINGS_MUTANT_LOADED: platform-isolation');\n" + source.replace(anchor, "result.connections.filter(record => record.config.adapterId !== 'discord')")
  }
}], test: { ...original.test, globalSetup: [], include: ['apps/desktop/test/telegram-settings-consumer.test.tsx', 'apps/desktop/test/discord-settings-consumer.test.tsx'], fileParallelism: false, passWithNoTests: false, testTimeout: 30_000 } })
