export const PRODUCT_NAME = 'AgentMux'
export const BUNDLE_ID = 'dev.agentmux.desktop'

/** The existing macOS brand output, shared by the actual writer and compatibility identity. */
export function applicationBranding(version) {
  return {
    executable: { source: 'Electron', target: PRODUCT_NAME },
    plist: {
      CFBundleDisplayName: PRODUCT_NAME, CFBundleName: PRODUCT_NAME, CFBundleIdentifier: BUNDLE_ID,
      CFBundleURLTypes: [{ CFBundleURLName: BUNDLE_ID, CFBundleURLSchemes: ['amux'], CFBundleTypeRole: 'Viewer' },
        { CFBundleURLName: `${BUNDLE_ID}.web`, CFBundleURLSchemes: ['http', 'https'], CFBundleTypeRole: 'Viewer' }],
      CFBundleDocumentTypes: ['public.html', 'public.xhtml'].map(type => ({ CFBundleTypeRole: 'Viewer', LSItemContentTypes: [type] })),
      CFBundleExecutable: PRODUCT_NAME, CFBundleIconFile: 'agentmux.icns',
      CFBundleShortVersionString: version, CFBundleVersion: version,
      LSApplicationCategoryType: 'public.app-category.developer-tools',
      NSScreenCaptureUsageDescription: 'AgentMux captures the screen area you select to attach it to your message.'
    },
    removedPlistKeys: ['NSAppTransportSecurity', 'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription',
      'NSBluetoothPeripheralUsageDescription', 'NSCameraUsageDescription', 'NSMicrophoneUsageDescription'],
    helpers: [{ suffix: '', idSuffix: '' }, { suffix: ' (Renderer)', idSuffix: '.renderer' },
      { suffix: ' (GPU)', idSuffix: '.gpu' }, { suffix: ' (Plugin)', idSuffix: '.plugin' }].map(helper => ({
      source: `Electron Helper${helper.suffix}`, target: `${PRODUCT_NAME} Helper${helper.suffix}`,
      plist: { CFBundleDisplayName: `${PRODUCT_NAME} Helper${helper.suffix}`, CFBundleName: `${PRODUCT_NAME} Helper${helper.suffix}`,
        CFBundleExecutable: `${PRODUCT_NAME} Helper${helper.suffix}`, CFBundleIdentifier: `${BUNDLE_ID}.helper${helper.idSuffix}` }
    })),
    icon: { source: 'resources/icon.icns', target: 'agentmux.icns' },
    removedResources: ['electron.icns', 'default_app.asar']
  }
}
