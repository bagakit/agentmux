/* Platform primitives for the same file bytes and publication protocol. */
#define NATIVE_SHA256_BYTES 32

#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
typedef CC_SHA256_CTX native_sha256_context;
static void native_sha256_init(native_sha256_context *context) { CC_SHA256_Init(context); }
static void native_sha256_update(native_sha256_context *context, const void *bytes, size_t length) {
  CC_SHA256_Update(context, bytes, (CC_LONG)length);
}
static void native_sha256_final(unsigned char *digest, native_sha256_context *context) { CC_SHA256_Final(digest, context); }
static void native_random(void *bytes, size_t length) { arc4random_buf(bytes, length); }
#define native_ctime_seconds(info) ((info)->st_ctimespec.tv_sec)
#define native_ctime_nanoseconds(info) ((info)->st_ctimespec.tv_nsec)
#define native_mtime_seconds(info) ((info)->st_mtimespec.tv_sec)
#define native_mtime_nanoseconds(info) ((info)->st_mtimespec.tv_nsec)
static int native_entry_stat(int fd, const char *name, struct stat *info) {
  return fstatat(fd, name, info, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH);
}
#elif defined(__linux__)
#include <openssl/evp.h>
#include <sys/random.h>
typedef EVP_MD_CTX *native_sha256_context;
static void native_sha256_init(native_sha256_context *context) {
  *context = EVP_MD_CTX_new();
  if (!*context) { errno = ENOMEM; fail_with_errno("allocate-sha256"); }
  if (EVP_DigestInit_ex(*context, EVP_sha256(), NULL) != 1) { errno = EIO; fail_with_errno("initialize-sha256"); }
}
static void native_sha256_update(native_sha256_context *context, const void *bytes, size_t length) {
  if (EVP_DigestUpdate(*context, bytes, length) != 1) { errno = EIO; fail_with_errno("update-sha256"); }
}
static void native_sha256_final(unsigned char *digest, native_sha256_context *context) {
  unsigned int length = 0;
  if (EVP_DigestFinal_ex(*context, digest, &length) != 1 || length != NATIVE_SHA256_BYTES) {
    errno = EIO; fail_with_errno("finish-sha256");
  }
  EVP_MD_CTX_free(*context);
}
static void native_random(void *bytes, size_t length) {
  for (size_t offset = 0; offset < length;) {
    const ssize_t count = getrandom((unsigned char *)bytes + offset, length - offset, 0);
    if (count < 0) { if (errno == EINTR) continue; fail_with_errno("temporary-entropy"); }
    if (!count) { errno = EIO; fail_with_errno("temporary-entropy"); }
    offset += (size_t)count;
  }
}
#define native_ctime_seconds(info) ((info)->st_ctim.tv_sec)
#define native_ctime_nanoseconds(info) ((info)->st_ctim.tv_nsec)
#define native_mtime_seconds(info) ((info)->st_mtim.tv_sec)
#define native_mtime_nanoseconds(info) ((info)->st_mtim.tv_nsec)
static int native_basename(const char *name) {
  return *name && !strchr(name, '/') && strcmp(name, ".") && strcmp(name, "..");
}
static int native_entry_stat(int fd, const char *name, struct stat *info) {
  if (!native_basename(name)) { errno = EINVAL; return -1; }
  return fstatat(fd, name, info, AT_SYMLINK_NOFOLLOW);
}
#else
#error "Workspace file operations are unavailable on this platform"
#endif

static void native_sha256(const void *bytes, size_t length, unsigned char *digest) {
  native_sha256_context context;
  native_sha256_init(&context);
  native_sha256_update(&context, bytes, length);
  native_sha256_final(digest, &context);
}
