import { describe, expect, it } from 'vitest'
import { browserCdpScopeRefusal, isBrowserCdpNativeInput } from '@agentmux/browser/page'

describe('raw cdp stays inside the page it drives', () => {
  it.each([
    ['Network.getAllCookies', 'sign-ins and site data'],
    ['Network.clearBrowserCookies', 'sign-ins and site data'],
    ['Storage.clearDataForOrigin', 'sign-ins and site data'],
    ['Storage.getCookies', 'sign-ins and site data'],
    ['Security.setIgnoreCertificateErrors', 'certificate checks or permissions'],
    ['Browser.grantPermissions', 'browser process'],
    ['Browser.close', 'browser process'],
    ['Target.createTarget', 'outside this Browser'],
    ['Target.activateTarget', 'outside this Browser'],
    ['Target.setAutoAttach', 'outside this Browser'],
    ['Page.close', 'outside this Browser'],
    ['Page.setDownloadBehavior', 'downloads are saved']
  ])('refuses %s, which reaches past the page', (method, reason) => {
    const refusal = browserCdpScopeRefusal(method)
    expect(refusal?.reason).toContain(reason)
    expect(refusal?.instead.length, 'a refusal names what to use instead').toBeGreaterThan(20)
  })

  it.each([
    'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Page.navigate', 'Page.reload',
    'Runtime.evaluate', 'DOM.getDocument', 'DOM.setFileInputFiles', 'Emulation.setDeviceMetricsOverride',
    'Network.enable', 'Network.getResponseBody', 'Network.setExtraHTTPHeaders', 'Accessibility.getFullAXTree',
    'CSS.getComputedStyleForNode', 'Input.dispatchMouseEvent', 'Overlay.highlightNode'
  ])('forwards %s, which acts on this page', method => {
    expect(browserCdpScopeRefusal(method)).toBeNull()
  })

  it('matches a method or a whole domain exactly, never a prefix of another name', () => {
    // A domain whose name starts like a refused one, and a method that merely contains a refused word.
    expect(browserCdpScopeRefusal('StorageInspector.read')).toBeNull()
    expect(browserCdpScopeRefusal('Network.getCookiesForUrl')).toBeNull()
    expect(browserCdpScopeRefusal('Page.closeAll')).toBeNull()
    // Inherited object keys are not entries.
    expect(browserCdpScopeRefusal('constructor')).toBeNull()
    expect(browserCdpScopeRefusal('toString.x')).toBeNull()
  })

  it('names the Input methods that are native input, so they run under Main’s receipt', () => {
    for (const method of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchTouchEvent']) {
      expect(isBrowserCdpNativeInput(method), method).toBe(true)
    }
    for (const method of ['Input.setIgnoreInputEvents', 'Runtime.evaluate', 'Input']) expect(isBrowserCdpNativeInput(method), method).toBe(false)
  })
})
