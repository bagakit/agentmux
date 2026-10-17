#import <AppKit/AppKit.h>
#include <node_api.h>

// This test-only bridge submits to the exact private NSWindow. No event is
// posted to the user's session or to another process, and no cursor is warped.
static napi_value Send(napi_env env, napi_callback_info info) {
  size_t count = 4, length = 0;
  napi_value args[4];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  void *handle = nullptr;
  int32_t kind = 0;
  double x = 0, y = 0;
  if (count != 4 || napi_get_buffer_info(env, args[0], &handle, &length) != napi_ok || length != sizeof(void *) ||
      napi_get_value_int32(env, args[1], &kind) != napi_ok || napi_get_value_double(env, args[2], &x) != napi_ok ||
      napi_get_value_double(env, args[3], &y) != napi_ok || kind < 0 || kind > 3) {
    napi_throw_type_error(env, nullptr, "Expected private native window handle, mouse kind and coordinates");
    return nullptr;
  }
  @autoreleasepool {
    NSView *view = (__bridge NSView *)(*static_cast<void **>(handle));
    NSWindow *window = view.window;
    if (!window || !window.visible || !NSThread.isMainThread) {
      napi_throw_error(env, nullptr, "The private native window must be visible on its Main thread");
      return nullptr;
    }
    NSView *content = window.contentView;
    NSPoint point = NSMakePoint(x, content.isFlipped ? y : content.bounds.size.height - y);
    NSView *hit = [content hitTest:point];
    NSPoint location = [content convertPoint:point toView:nil];
    const NSEventType types[] = { NSEventTypeMouseMoved, NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp, NSEventTypeLeftMouseDragged };
    NSEvent *event = [NSEvent mouseEventWithType:types[kind] location:location modifierFlags:0
      timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
      eventNumber:1 clickCount:kind == 1 || kind == 2 ? 1 : 0 pressure:kind == 1 || kind == 3 ? 1 : 0];
    window.acceptsMouseMovedEvents = YES;
    [window sendEvent:event];
    napi_value result;
    napi_create_string_utf8(env, NSStringFromClass(hit.class).UTF8String ?: "none", NAPI_AUTO_LENGTH, &result);
    return result;
  }
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "send", NAPI_AUTO_LENGTH, Send, nullptr, &function);
  napi_set_named_property(env, exports, "send", function);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
