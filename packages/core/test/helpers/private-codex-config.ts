// Isolate native verification from user plugins, notifications and credential stores.
export const privateCodexConfigArgs = ['--config', 'cli_auth_credentials_store="file"', '--config', 'notify=[]',
  '--config', 'features.plugins=false', '--config', 'features.plugin_hooks=false', '--config', 'features.memories=false', '--config', 'features.chronicle=false']
