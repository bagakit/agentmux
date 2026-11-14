#import <AppKit/AppKit.h>
#import <CoreLocation/CoreLocation.h>
#include <node_api.h>
#include <cmath>
#include <cstring>
#include <memory>

struct LocationResult {
  const char *state;
  double latitude = 0;
  double longitude = 0;
};

static napi_value makeResult(napi_env env, const LocationResult &result) {
  napi_value object, value;
  napi_create_object(env, &object);
  napi_create_string_utf8(env, result.state, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "state", value);
  if (std::strcmp(result.state, "located") == 0) {
    napi_create_double(env, result.latitude, &value);
    napi_set_named_property(env, object, "latitude", value);
    napi_create_double(env, result.longitude, &value);
    napi_set_named_property(env, object, "longitude", value);
  }
  return object;
}

static void resolveLocation(napi_env env, napi_value, void *context, void *data) {
  std::unique_ptr<LocationResult> result(static_cast<LocationResult *>(data));
  if (env) napi_resolve_deferred(env, static_cast<napi_deferred>(context), makeResult(env, *result));
}

@interface AgentMuxLocationQuery : NSObject <CLLocationManagerDelegate>
- (void)start:(napi_threadsafe_function)completion;
@end

static AgentMuxLocationQuery *activeQuery;

@implementation AgentMuxLocationQuery {
  CLLocationManager *_manager;
  napi_threadsafe_function _completion;
  bool _requestedLocation;
}

- (void)finish:(LocationResult)result {
  if (!_completion) return;
  _manager.delegate = nil;
  if (_requestedLocation) [_manager stopUpdatingLocation];
  _manager = nil;
  auto completion = _completion;
  _completion = nullptr;
  auto *payload = new LocationResult(result);
  if (napi_call_threadsafe_function(completion, payload, napi_tsfn_nonblocking) != napi_ok) delete payload;
  napi_release_threadsafe_function(completion, napi_tsfn_release);
  activeQuery = nil;
}

- (void)start:(napi_threadsafe_function)completion {
  _completion = completion;
  _manager = [[CLLocationManager alloc] init];
  _manager.desiredAccuracy = kCLLocationAccuracyHundredMeters;
  __weak AgentMuxLocationQuery *query = self;
  _manager.delegate = self;
  if (_manager.authorizationStatus == kCLAuthorizationStatusNotDetermined) {
    [_manager requestWhenInUseAuthorization];
  } else {
    [self locationManagerDidChangeAuthorization:_manager];
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 45 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    [query finish:LocationResult{"timeout"}];
  });
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
  switch (manager.authorizationStatus) {
    case kCLAuthorizationStatusAuthorizedAlways:
      if (!_requestedLocation) {
        _requestedLocation = true;
        [manager requestLocation];
      }
      break;
    case kCLAuthorizationStatusDenied:
      [self finish:LocationResult{"denied"}];
      break;
    case kCLAuthorizationStatusRestricted:
      [self finish:LocationResult{"restricted"}];
      break;
    case kCLAuthorizationStatusNotDetermined:
      break;
  }
}

- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
  for (CLLocation *location in locations.reverseObjectEnumerator) {
    const CLLocationCoordinate2D point = location.coordinate;
    if (CLLocationCoordinate2DIsValid(point) && std::isfinite(location.horizontalAccuracy) &&
        location.horizontalAccuracy >= 0 && std::abs(location.timestamp.timeIntervalSinceNow) <= 60) {
      [self finish:LocationResult{"located", point.latitude, point.longitude}];
      return;
    }
  }
  [self finish:LocationResult{"unavailable"}];
}

- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
  const bool denied = [error.domain isEqualToString:kCLErrorDomain] && error.code == kCLErrorDenied;
  [self finish:LocationResult{denied ? "denied" : "unavailable"}];
}
@end

static napi_value readLocation(napi_env env, napi_callback_info) {
  napi_deferred deferred;
  napi_value promise;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;
  if (!NSThread.isMainThread || !NSApp.isActive) {
    napi_resolve_deferred(env, deferred, makeResult(env, {"not-focused"}));
    return promise;
  }
  if (activeQuery) {
    napi_resolve_deferred(env, deferred, makeResult(env, {"busy"}));
    return promise;
  }
  napi_value resource;
  napi_create_string_utf8(env, "AgentMux map location", NAPI_AUTO_LENGTH, &resource);
  napi_threadsafe_function completion;
  if (napi_create_threadsafe_function(env, nullptr, nullptr, resource, 1, 1, nullptr, nullptr,
      deferred, resolveLocation, &completion) != napi_ok) {
    napi_resolve_deferred(env, deferred, makeResult(env, {"unavailable"}));
    return promise;
  }
  napi_unref_threadsafe_function(env, completion);
  AgentMuxLocationQuery *query = [[AgentMuxLocationQuery alloc] init];
  activeQuery = query;
  [query start:completion];
  return promise;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value read;
  napi_create_function(env, "read", NAPI_AUTO_LENGTH, readLocation, nullptr, &read);
  napi_set_named_property(env, exports, "read", read);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
