/* Exact path discovery and mkdir use the original helper's confined descriptors.
 * The private producer directory is retained across a missing reply. Readers
 * inspect it; they never re-enter publication or adopt an unrelated basename. */
typedef struct { struct stat file; long long birthtime_ns; int birthtime_known; } path_info;

static int path_entry_info(int fd, const char *name, path_info *info) {
  if (fstatat(fd, name, &info->file, AT_SYMLINK_NOFOLLOW)) return -1;
#if defined(__linux__)
  struct statx extra;
  info->birthtime_known = !statx(fd, name, AT_SYMLINK_NOFOLLOW, STATX_BTIME, &extra) && (extra.stx_mask & STATX_BTIME);
  info->birthtime_ns = info->birthtime_known ? (long long)extra.stx_btime.tv_sec * 1000000000LL + extra.stx_btime.tv_nsec : 0;
#else
  info->birthtime_ns = 0; info->birthtime_known = 1;
#endif
  return 0;
}
static int path_fd_info(int fd, path_info *info) {
  if (fstat(fd, &info->file)) return -1;
#if defined(__linux__)
  struct statx extra;
  info->birthtime_known = !statx(fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_BTIME, &extra) && (extra.stx_mask & STATX_BTIME);
  info->birthtime_ns = info->birthtime_known ? (long long)extra.stx_btime.tv_sec * 1000000000LL + extra.stx_btime.tv_nsec : 0;
#else
  info->birthtime_ns = 0; info->birthtime_known = 1;
#endif
  return 0;
}

typedef struct {
  int root, parent;
  char root_path[PATH_MAX], parent_path[PATH_MAX], name[NAME_MAX + 1];
  path_info root_info, parent_info;
} path_scope;

static long long path_birth_ns(const path_info *info) {
#if defined(__APPLE__)
  return (long long)info->file.st_birthtimespec.tv_sec * 1000000000LL + info->file.st_birthtimespec.tv_nsec;
#else
  /* Linux exposes the original generation through statx on the pinned inode. */
  return info->birthtime_ns;
#endif
}

static void path_witness_text(const path_info *info, char *out, size_t size) {
  char birth[64]; if (info->birthtime_known) snprintf(birth, sizeof(birth), "%lld", path_birth_ns(info)); else strcpy(birth, "unavailable");
  snprintf(out, size, "%llu:%llu:%llu:%lld:%lld:%s",
    (unsigned long long)info->file.st_dev, (unsigned long long)info->file.st_ino,
    (unsigned long long)info->file.st_size, workspace_ctime(&info->file), workspace_mtime(&info->file), birth);
}

static void path_witness_output(FILE *output, const path_info *info) {
  fprintf(output, "{\"device\":\"%llu\",\"inode\":\"%llu\",\"size\":\"%llu\",\"ctimeNs\":\"%lld\",\"mtimeNs\":\"%lld\",\"birthtimeNs\":",
    (unsigned long long)info->file.st_dev, (unsigned long long)info->file.st_ino,
    (unsigned long long)info->file.st_size, workspace_ctime(&info->file), workspace_mtime(&info->file));
  if (info->birthtime_known) fprintf(output, "\"%lld\"}", path_birth_ns(info)); else fprintf(output, "null}");
}

static void path_witness_json(const path_info *info) { path_witness_output(stdout, info); }

static int path_same_entry(const path_info *a, const path_info *b) {
  char before[256], after[256]; path_witness_text(a, before, sizeof(before)); path_witness_text(b, after, sizeof(after));
  return (a->file.st_mode & S_IFMT) == (b->file.st_mode & S_IFMT) && !strcmp(before, after);
}

static int path_identity_equal(const path_info *a, const path_info *b) {
  return a->file.st_dev == b->file.st_dev && a->file.st_ino == b->file.st_ino &&
    (a->file.st_mode & S_IFMT) == (b->file.st_mode & S_IFMT) && a->birthtime_known == b->birthtime_known && (!a->birthtime_known || path_birth_ns(a) == path_birth_ns(b));
}

/* Optional body provenance only. Failed/over-budget observation never fails IO. */
#define WORKSPACE_READ_ANCESTORS 256
#define WORKSPACE_READ_METADATA_BYTES 65536
struct workspace_read_scope {
  int root, parent;
  char root_path[PATH_MAX];
  path_info file, root_info, ancestors[WORKSPACE_READ_ANCESTORS];
  size_t count;
};
static size_t workspace_read_ancestors(int parent, const path_info *root, path_info *items) {
  int cursor = dup(parent);
  if (cursor < 0) return 0;
  for (size_t i = 0; i < WORKSPACE_READ_ANCESTORS; i++) {
    if (path_fd_info(cursor, &items[i]) || !items[i].birthtime_known || !S_ISDIR(items[i].file.st_mode)) break;
    if (path_identity_equal(&items[i], root)) { close(cursor); return i + 1; }
    const int next = openat(cursor, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    path_info above;
    if (next < 0) break;
    if (path_fd_info(next, &above) || path_identity_equal(&above, &items[i])) { close(next); break; }
    close(cursor); cursor = next;
  }
  close(cursor); return 0;
}
static void workspace_read_scope_close(workspace_read_scope *scope) {
  if (!scope) return;
  if (scope->root >= 0) close(scope->root);
  if (scope->parent >= 0) close(scope->parent);
  free(scope);
}
static workspace_read_scope *workspace_read_scope_open(const char *root, int fd) {
  if (strlen(root) >= PATH_MAX) return NULL;
  workspace_read_scope *scope = calloc(1, sizeof(*scope));
  if (!scope) return NULL;
  scope->root = scope->parent = -1; strcpy(scope->root_path, root);
  scope->root = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  scope->parent = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (scope->root < 0 || scope->parent < 0 || path_fd_info(fd, &scope->file) || !scope->file.birthtime_known ||
      path_fd_info(scope->root, &scope->root_info) || !scope->root_info.birthtime_known ||
      !(scope->count = workspace_read_ancestors(scope->parent, &scope->root_info, scope->ancestors))) {
    workspace_read_scope_close(scope); return NULL;
  }
  return scope;
}
static void workspace_read_scope_finish(workspace_read_scope *scope, int fd) {
  if (!scope) return;
  path_info file, root, ancestors[WORKSPACE_READ_ANCESTORS];
  if (path_fd_info(fd, &file) || !path_same_entry(&file, &scope->file) ||
      path_entry_info(AT_FDCWD, scope->root_path, &root) || !path_identity_equal(&root, &scope->root_info) ||
      workspace_read_ancestors(scope->parent, &scope->root_info, ancestors) != scope->count) return;
  for (size_t i = 0; i < scope->count; i++) if (!path_identity_equal(&ancestors[i], &scope->ancestors[i])) return;
  char *body = NULL; size_t length = 0;
  FILE *output = open_memstream(&body, &length);
  if (!output) return;
  fputs("{\"entry\":", output); path_witness_output(output, &file); fputs(",\"ancestorWitnesses\":[", output);
  for (size_t i = 0; i < scope->count; i++) { if (i) fputc(',', output); path_witness_output(output, &scope->ancestors[i]); }
  fputs("]}", output);
  if (!fclose(output) && length <= WORKSPACE_READ_METADATA_BYTES) {
    fputs("AGENTMUX_WORKSPACE_READ_IDENTITY:", stderr); fwrite(body, 1, length, stderr); fputc('\n', stderr);
  }
  free(body);
}

static int path_witness_equal(const path_info *info, const char *expected) {
  char actual[256]; path_witness_text(info, actual, sizeof(actual)); return !strcmp(actual, expected);
}

static int path_open_parent(int root, const char *path) {
  int fd = dup(root); if (fd < 0) workspace_errno();
  if (!strcmp(path, ".")) return fd;
  char *storage = strdup(path), *cursor = storage;
  if (!storage) workspace_errno();
  while (cursor) {
    char *slash = strchr(cursor, '/'); if (slash) *slash = 0;
    const int next = openat(fd, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    const int saved = errno; close(fd);
    if (next < 0) { free(storage); errno = saved; return -1; }
    fd = next; cursor = slash ? slash + 1 : NULL;
  }
  free(storage); return fd;
}

static path_scope path_open_scope(const char *root, const char *relative_path, int allow_root) {
  path_scope scope;
  if (!*root || root[0] != '/' || strlen(root) >= PATH_MAX || strlen(relative_path) >= PATH_MAX)
    workspace_error("FILE_PATH_INVALID_SCOPE", "The original absolute root and bounded relative path are required");
  if (!allow_root || strcmp(relative_path, ".")) validate_relative_path(relative_path);
  strcpy(scope.root_path, root);
  scope.root = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (scope.root < 0 || path_fd_info(scope.root, &scope.root_info)) workspace_errno();
  char *path = strdup(relative_path); if (!path) workspace_errno();
  char *slash = strrchr(path, '/');
  if (strlen(slash ? slash + 1 : path) > NAME_MAX) workspace_error("FILE_PATH_INVALID_SCOPE", "The original entry name is too long");
  strcpy(scope.name, slash ? slash + 1 : path);
  if (slash) { *slash = 0; strcpy(scope.parent_path, path); }
  else strcpy(scope.parent_path, ".");
  free(path);
  scope.parent = path_open_parent(scope.root, scope.parent_path);
  if (scope.parent < 0 || path_fd_info(scope.parent, &scope.parent_info)) workspace_errno();
  return scope;
}

static int path_scope_current(const path_scope *scope) {
  path_info root, parent;
  if (path_entry_info(AT_FDCWD, scope->root_path, &root) || !path_identity_equal(&root, &scope->root_info)) return 0;
  const int fd = path_open_parent(scope->root, scope->parent_path);
  if (fd < 0) return 0;
  const int same = !path_fd_info(fd, &parent) && path_identity_equal(&parent, &scope->parent_info);
  close(fd); return same;
}

static void path_scope_close(path_scope *scope) { close(scope->parent); close(scope->root); }

static const char *path_kind(const path_info *info) {
  return S_ISREG(info->file.st_mode) ? "file" : S_ISDIR(info->file.st_mode) ? "directory" : S_ISLNK(info->file.st_mode) ? "symlink" : "other";
}

static void path_stat_revision_barrier(void) { commit_barrier(1, 3, 4, "during-stat-revision"); }
static void path_stat(const path_scope *scope, int include_revision, const char *fault) {
  path_info entry, after, parent, root;
  const int found = !path_entry_info(scope->parent, scope->name, &entry);
  if (!found && errno != ENOENT) workspace_errno();
  int fd = -1; char revision[72];
  if (include_revision && found && S_ISREG(entry.file.st_mode)) {
    fd = openat(scope->parent, scope->name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    path_info opened; struct stat hashed;
    if (fd < 0 || path_fd_info(fd, &opened)) workspace_errno();
    if (!path_same_entry(&entry, &opened)) workspace_error("FILE_PATH_ENTRY_CHANGED", "The opened file differs from the original entry observation");
    if (!strcmp(fault, "during-stat-revision-barrier")) workspace_revision_after_chunk = path_stat_revision_barrier;
    if (!workspace_fd_revision(fd, revision, &hashed, entry.file.st_size) || !workspace_same_file(&entry.file, &hashed) || path_fd_info(fd, &opened) || !path_same_entry(&entry, &opened))
      workspace_error("FILE_PATH_ENTRY_CHANGED", "The original regular file changed while computing its revision");
  }
  char root_witness[256], parent_witness[256];
  path_witness_text(&scope->root_info, root_witness, sizeof(root_witness));
  path_witness_text(&scope->parent_info, parent_witness, sizeof(parent_witness));
  if (!path_scope_current(scope) || path_fd_info(scope->parent, &parent) || path_fd_info(scope->root, &root) ||
      (include_revision ? !path_identity_equal(&root, &scope->root_info) || !path_identity_equal(&parent, &scope->parent_info) : !path_witness_equal(&root, root_witness) || !path_witness_equal(&parent, parent_witness)))
    workspace_error("FILE_PATH_SCOPE_CHANGED", "The original root or parent changed during stat");
  const int final_found = !path_entry_info(scope->parent, scope->name, &after);
  if ((!final_found && errno != ENOENT) || final_found != found || (found && !path_same_entry(&entry, &after)))
    workspace_error("FILE_PATH_ENTRY_CHANGED", "The original directory entry changed during stat");
  if (fd >= 0) close(fd);
  printf("{\"root\":"); path_witness_json(&root); printf(",\"parent\":"); path_witness_json(&parent);
  printf(",\"parentPath\":"); workspace_json_string(stdout, scope->parent_path);
  if (found) { printf(",\"entry\":{\"kind\":\"%s\",\"witness\":", path_kind(&entry)); path_witness_json(&entry); printf("}"); }
  else printf(",\"entry\":{\"kind\":\"absent\"}");
  if (include_revision) {
    if (found && S_ISREG(entry.file.st_mode)) { printf(",\"revision\":{\"status\":\"observed\",\"revision\":"); workspace_json_string(stdout, revision); printf("}"); }
    else printf(",\"revision\":{\"status\":\"not-applicable\"}");
  }
#if defined(__APPLE__)
  const char *platform = "darwin";
#else
  const char *platform = "linux";
#endif
  printf(",\"implementation\":{\"platform\":\"%s\",\"stat\":\"native\",\"mkdir\":\"%s\"}}", platform, !root.birthtime_known || !parent.birthtime_known ? "generation-unavailable" : "native-no-replace");
}

static void path_refused(const char *code, const char *message) {
  printf("{\"action\":\"mkdir\",\"phase\":\"settled\",\"filesystem\":\"not-applied\",\"durability\":\"confirmed\",\"code\":");
  workspace_json_string(stdout, code); printf(",\"message\":"); workspace_json_string(stdout, message); printf("}");
}

static void path_created(const path_info *info, int confirmed) {
  printf("{\"action\":\"mkdir\",\"phase\":\"published\",\"filesystem\":\"created\",\"durability\":\"%s\",\"createdWitness\":", confirmed ? "confirmed" : "unconfirmed");
  path_witness_json(info); printf("}");
}

static void path_unknown(const char *message) {
  printf("{\"action\":\"mkdir\",\"phase\":\"prepared\",\"filesystem\":\"unknown\",\"durability\":\"unconfirmed\",\"code\":\"FILE_MKDIR_UNCONFIRMED\",\"message\":");
  workspace_json_string(stdout, message); printf("}");
}

/* The dedicated pipe is a stable native protocol, not stdout presentation.
 * The original Host must durably retain these identities before publication. */
static void path_offer_stage(const path_info *stage, const path_info *entry) {
  FILE *output = fdopen(dup(3), "w"); if (!output) workspace_errno();
  fprintf(output, "{\"stage\":"); path_witness_output(output, stage);
  fprintf(output, ",\"entry\":"); path_witness_output(output, entry); fprintf(output, "}\n");
  if (fflush(output) || fclose(output)) workspace_errno();
  char ack;
  if (read(4, &ack, 1) != 1 || ack != 'G') workspace_error("FILE_PATH_STAGE_UNCONFIRMED", "The original Host did not confirm its stage witness; publication was not released");
}

static int path_move_between(int from_fd, const char *from, int to_fd, const char *to) {
#if defined(__APPLE__)
  return renameatx_np(from_fd, from, to_fd, to, RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH);
#else
  return renameat2(from_fd, from, to_fd, to, RENAME_NOREPLACE);
#endif
}
static int path_move_new_directory(const path_scope *scope, int stage_fd) {
  return path_move_between(stage_fd, "entry", scope->parent, scope->name);
}

static int path_original_directory(const path_info *info, const char *witness) {
  if (!info->birthtime_known || strlen(witness) > 255) return 0;
  char copy[256]; strcpy(copy, witness);
  char *parts[6], *cursor = copy;
  for (int index = 0; index < 6; index++) {
    parts[index] = cursor;
    char *next = strchr(cursor, ':');
    if ((index < 5 && !next) || (index == 5 && next)) return 0;
    if (next) { *next = 0; cursor = next + 1; }
  }
  char expected[128], actual[128];
  snprintf(expected, sizeof(expected), "%s:%s:%s", parts[0], parts[1], parts[5]);
  snprintf(actual, sizeof(actual), "%llu:%llu:%lld", (unsigned long long)info->file.st_dev,
    (unsigned long long)info->file.st_ino, path_birth_ns(info));
  return !strcmp(expected, actual);
}

static void path_mkdir_inspect(const path_scope *scope, const char *root_witness,
                              const char *parent_witness, const char *entry_witness) {
  if (!path_original_directory(&scope->root_info, root_witness) || !path_original_directory(&scope->parent_info, parent_witness)) {
    path_unknown("The original root or parent generation is unavailable. No action was replayed."); return;
  }
  path_info visible;
  if (path_scope_current(scope) && !path_entry_info(scope->parent, scope->name, &visible) && S_ISDIR(visible.file.st_mode) && path_original_directory(&visible, entry_witness))
    path_created(&visible, 0);
  else path_unknown("The exact original created identity is not confirmed at its target. Its request and producer witness are retained; no action was replayed.");
}

/* Only an empty, exact original private container is retired, never user trees. */
static void path_retire_empty_stage(const path_scope *scope, const char *name, const path_info *original) {
  if (!path_scope_current(scope)) return;
  char retiring[NAME_MAX + 1];
  if (snprintf(retiring, sizeof(retiring), "%s.retired", name) > NAME_MAX) return;
  if (atomic_move_no_replace(scope->parent, name, retiring)) return;
  path_info claimed;
  if (path_entry_info(scope->parent, retiring, &claimed) || !path_identity_equal(original, &claimed)) {
    if (atomic_move_no_replace(scope->parent, retiring, name)) fprintf(stderr, "Original mkdir stage cleanup is unconfirmed; both names are retained.\n");
    return;
  }
  if (unlinkat(scope->parent, retiring, AT_REMOVEDIR)) fprintf(stderr, "Original nonempty mkdir stage is retained; no recursive cleanup was attempted.\n");
  else if (fsync(scope->parent)) fprintf(stderr, "Original empty mkdir stage cleanup sync is unconfirmed.\n");
}

static void path_mkdir(path_scope *scope, const char *stage_name,
                       const char *root_witness, const char *parent_witness, const char *fault) {
  if (!scope->root_info.birthtime_known || !scope->parent_info.birthtime_known) {
    path_refused("FILE_PATH_GENERATION_UNAVAILABLE", "This filesystem does not expose the original directory birth generation required by exact mkdir"); return;
  }
  if (!path_original_directory(&scope->root_info, root_witness) || !path_original_directory(&scope->parent_info, parent_witness)) {
    path_refused("FILE_PATH_SCOPE_CONFLICT", "The observed original root or parent generation changed"); return;
  }
  if (!strcmp(fault, "before-stage-crash")) _exit(91);
  commit_barrier(!strcmp(fault, "before-stage-barrier"), 3, 4, "before-path-stage");
  if (!path_scope_current(scope)) { path_refused("FILE_PATH_SCOPE_CONFLICT", "The original parent moved before directory creation"); return; }
  path_info target;
  if (!path_entry_info(scope->parent, scope->name, &target) || errno != ENOENT) {
    path_refused("FILE_PATH_OCCUPIED", "The destination entry is occupied or its absence is unconfirmed"); return;
  }
  if (mkdirat(scope->parent, stage_name, 0700)) workspace_errno();
  const int stage = openat(scope->parent, stage_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (stage < 0 || mkdirat(stage, "entry", 0777)) workspace_errno();
  path_info entry;
  if (path_entry_info(stage, "entry", &entry)) workspace_errno();
  path_info stage_info;
  if (path_fd_info(stage, &stage_info)) workspace_errno();
  const int entry_fd = openat(stage, "entry", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (entry_fd < 0 || fsync(entry_fd) || fsync(stage) || fsync(scope->parent)) workspace_errno();
  if (!entry.birthtime_known || !stage_info.birthtime_known) {
    close(entry_fd); close(stage); path_refused("FILE_PATH_GENERATION_UNAVAILABLE", "The created directory generation is unavailable; no publication was issued"); return;
  }
  if (!strcmp(fault, "before-stage-offer-crash")) _exit(95);
  path_offer_stage(&stage_info, &entry);
  if (!strcmp(fault, "after-stage-crash")) _exit(92);
  commit_barrier(!strcmp(fault, "before-publish-barrier"), 5, 6, "before-path-publish");
  if (!path_scope_current(scope)) { close(entry_fd); close(stage); path_refused("FILE_PATH_SCOPE_CONFLICT", "The original parent changed before publication; its private stage is retained"); return; }
  path_info current_stage, current_entry;
  if (path_entry_info(scope->parent, stage_name, &current_stage) || path_fd_info(stage, &target) || !path_identity_equal(&current_stage, &target) ||
      path_entry_info(stage, "entry", &current_entry) || !path_identity_equal(&current_entry, &entry))
    workspace_error("FILE_PATH_STAGE_CHANGED", "The original private producer stage changed");
  commit_barrier(!strcmp(fault, "at-publish-barrier"), 5, 6, "at-path-publish");
  if (path_move_new_directory(scope, stage)) {
    if (errno == EEXIST || errno == ENOTEMPTY) { close(entry_fd); close(stage); path_refused("FILE_PATH_OCCUPIED", "A later destination entry was preserved"); return; }
    if (errno == ENOSYS || errno == ENOTSUP || errno == EOPNOTSUPP) { close(entry_fd); close(stage); path_refused("FILE_PATH_NATIVE_UNSUPPORTED", "This kernel or filesystem does not support atomic no-replace directory publication; existing entries and the original stage are retained"); return; }
    workspace_errno();
  }
  workspace_write_published = 1;
  if (!strcmp(fault, "after-publish-crash")) _exit(93);
  if (!strcmp(fault, "directory-sync")) workspace_error("EIO", "Injected directory confirmation failure");
  if (fsync(entry_fd) || fsync(stage) || fsync(scope->parent) || fsync(scope->root)) workspace_errno();
  if (!path_scope_current(scope) || path_entry_info(scope->parent, scope->name, &target) || !path_identity_equal(&entry, &target))
    workspace_error("FILE_PATH_SCOPE_CHANGED", "The original scope or created identity changed after publication");
  if (!strcmp(fault, "lost-reply")) _exit(94);
  path_retire_empty_stage(scope, stage_name, &stage_info);
  path_created(&target, 1); close(entry_fd); close(stage);
}


/* Compare pinned directory ancestors, including a Workspace-external alias and
 * an original object now held under its own claim name. No Run fact is inferred. */
static int path_ancestor_relation(int directory, const char *entry_witness) {
  int current = dup(directory); if (current < 0) return -1;
  for (int depth = 0; depth < 4096; depth++) {
    path_info info, parent_info;
    if (path_fd_info(current, &info)) { close(current); return -1; }
    char identity_prefix[96];
    snprintf(identity_prefix, sizeof(identity_prefix), "%llu:%llu:", (unsigned long long)info.file.st_dev, (unsigned long long)info.file.st_ino);
    if (!info.birthtime_known && !strncmp(entry_witness, identity_prefix, strlen(identity_prefix))) { close(current); errno = ENOTSUP; return -1; }
    if (path_original_directory(&info, entry_witness)) { close(current); return 1; }
    const int parent = openat(current, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0 || path_fd_info(parent, &parent_info)) { if (parent >= 0) close(parent); close(current); return -1; }
    const int root = path_identity_equal(&info, &parent_info);
    close(current); current = parent;
    if (root) { close(current); return 0; }
  }
  close(current); errno = ELOOP; return -1;
}
static void path_directory_relation(const char *witness, const char *cwd) {
  const int directory = open(cwd, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (directory < 0) {
    printf("{\"status\":\"%s\"}", errno == ENOENT || errno == ENOTDIR ? "missing" : "unavailable"); return;
  }
  const int related = path_ancestor_relation(directory, witness); close(directory);
  printf("{\"status\":\"%s\"}", related < 0 ? "unavailable" : related ? "related" : "unrelated");
}
static void path_move_receipt(const char *phase, const char *effect, int confirmed,
                              const path_info *entry, const char *code, const char *message) {
  printf("{\"action\":\"move\",\"phase\":\"%s\",\"filesystem\":\"%s\",\"durability\":\"%s\"",
    phase, effect, confirmed ? "confirmed" : "unconfirmed");
  if (entry) { printf(",\"movedWitness\":"); path_witness_json(entry); }
  if (code) { printf(",\"code\":"); workspace_json_string(stdout, code); }
  if (message) { printf(",\"message\":"); workspace_json_string(stdout, message); }
  printf("}");
}
static void path_offer_move(const char *phase, const path_info *stage, const path_info *entry) {
  FILE *output = fdopen(dup(3), "w"); if (!output) workspace_errno();
  fprintf(output, "{\"phase\":\"%s\",\"stage\":", phase); path_witness_output(output, stage);
  fprintf(output, ",\"entry\":"); path_witness_output(output, entry); fprintf(output, "}\n");
  if (fflush(output) || fclose(output)) workspace_errno();
  char ack;
  if (read(4, &ack, 1) != 1 || ack != 'G') workspace_error("FILE_MOVE_PHASE_UNCONFIRMED", "The original Host did not release this exact move phase");
}
static int path_return_claim(const path_scope *source, int stage, const path_info *claimed) {
  if (path_move_between(stage, "entry", source->parent, source->name)) return 0;
  path_info restored;
  return !fsync(stage) && !fsync(source->parent) && path_scope_current(source) &&
    !path_entry_info(source->parent, source->name, &restored) && path_identity_equal(claimed, &restored);
}
static void path_move(path_scope *source, path_scope *destination, const char *stage_name,
                      const char *source_root, const char *source_parent, const char *entry_witness,
                      const char *entry_kind, const char *destination_root, const char *destination_parent,
                      const char *fault) {
  if (!source->root_info.birthtime_known || !source->parent_info.birthtime_known || !destination->root_info.birthtime_known || !destination->parent_info.birthtime_known) {
    path_move_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_GENERATION_UNAVAILABLE", "The exact original directory generation is unavailable"); return;
  }
  if (!path_original_directory(&source->root_info, source_root) || !path_original_directory(&source->parent_info, source_parent) ||
      !path_original_directory(&destination->root_info, destination_root) || !path_original_directory(&destination->parent_info, destination_parent) ||
      !path_scope_current(source) || !path_scope_current(destination)) {
    path_move_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_SCOPE_CONFLICT", "The original source or destination scope changed"); return;
  }
  path_info entry, occupied;
  if (path_entry_info(source->parent, source->name, &entry)) {
    path_move_receipt("settled", "not-applied", 1, NULL, "FILE_MOVE_SOURCE_CONFLICT", "The exact original source entry is unavailable"); return;
  }
  if (!entry.birthtime_known) {
    path_move_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_GENERATION_UNAVAILABLE", "The original source generation is unavailable"); return;
  }
  if (!path_original_directory(&entry, entry_witness) || strcmp(path_kind(&entry), entry_kind)) {
    path_move_receipt("settled", "not-applied", 1, NULL, "FILE_MOVE_SOURCE_CONFLICT", "The exact original source entry changed"); return;
  }
  if (entry.file.st_dev != destination->parent_info.file.st_dev) {
    path_move_receipt("settled", "not-applied", 1, NULL, "FILE_MOVE_CROSS_DEVICE", "Move requires one original filesystem; no copy-delete was attempted"); return;
  }
  if (S_ISDIR(entry.file.st_mode)) {
    const int inside = path_ancestor_relation(destination->parent, entry_witness);
    if (inside) { path_move_receipt("settled", "not-applied", 1, NULL, inside < 0 ? "FILE_MOVE_SCOPE_UNAVAILABLE" : "FILE_MOVE_INTO_SELF", "The destination is inside the original source or its ancestry is unconfirmed"); return; }
  }
  if (!path_entry_info(destination->parent, destination->name, &occupied) || errno != ENOENT) {
    path_move_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_OCCUPIED", "The destination entry was preserved"); return;
  }
  if (mkdirat(source->parent, stage_name, 0700)) workspace_errno();
  const int stage = openat(source->parent, stage_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  path_info stage_info;
  if (stage < 0 || path_fd_info(stage, &stage_info) || fsync(stage) || fsync(source->parent)) workspace_errno();
  if (!stage_info.birthtime_known) { close(stage); path_move_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_GENERATION_UNAVAILABLE", "The original claim generation is unavailable"); return; }
  path_offer_move("staged", &stage_info, &entry);
  if (!strcmp(fault, "move-after-stage-crash")) _exit(101);
  commit_barrier(!strcmp(fault, "before-move-claim-barrier"), 5, 6, "before-path-move-claim");
  if (!path_scope_current(source) || !path_scope_current(destination)) {
    close(stage); path_move_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_SCOPE_CONFLICT", "The original scope changed before claim"); return;
  }
  path_info current_stage;
  if (path_entry_info(source->parent, stage_name, &current_stage) || !path_identity_equal(&current_stage, &stage_info)) workspace_error("FILE_MOVE_STAGE_CHANGED", "The original claim container changed");
  if (path_move_between(source->parent, source->name, stage, "entry")) {
    const int saved = errno; close(stage);
    path_move_receipt("settled", "not-applied", 1, NULL, saved == ENOSYS || saved == ENOTSUP || saved == EOPNOTSUPP ? "FILE_PATH_NATIVE_UNSUPPORTED" : "FILE_MOVE_CLAIM_REFUSED", "The original source was not claimed"); return;
  }
  workspace_write_published = 1;
  path_info claimed;
  if (path_entry_info(stage, "entry", &claimed)) workspace_errno();
  if (!path_identity_equal(&entry, &claimed) || strcmp(path_kind(&claimed), entry_kind)) {
    const int restored = path_return_claim(source, stage, &claimed); close(stage);
    path_move_receipt(restored ? "settled" : "claimed", restored ? "not-applied" : "unknown", restored, NULL,
      "FILE_MOVE_SOURCE_CONFLICT", restored ? "A late replacement was returned without overwriting another entry" : "The late replacement is retained in the original claim; no destination publication was issued"); return;
  }
  if (fsync(stage) || fsync(source->parent) || path_fd_info(stage, &stage_info)) workspace_errno();
  if (!strcmp(fault, "move-after-claim-crash")) _exit(102);
  path_offer_move("claimed", &stage_info, &claimed);
  if (!strcmp(fault, "move-after-claim-ack-crash")) _exit(103);
  if (!path_scope_current(source) || !path_scope_current(destination)) {
    close(stage); path_move_receipt("claimed", "unknown", 0, NULL, "FILE_PATH_SCOPE_CONFLICT", "The original scope changed after claim; no destination publication was issued"); return;
  }
  path_info final_entry;
  if (path_entry_info(stage, "entry", &final_entry) || !path_identity_equal(&claimed, &final_entry)) workspace_error("FILE_MOVE_CLAIM_CHANGED", "The exact original claimed source changed");
  commit_barrier(!strcmp(fault, "at-move-publish-barrier"), 5, 6, "at-path-move-publish");
  if (path_move_between(stage, "entry", destination->parent, destination->name)) {
    const int saved = errno, restored = path_return_claim(source, stage, &claimed); close(stage);
    path_move_receipt(restored ? "settled" : "claimed", restored ? "not-applied" : "unknown", restored, NULL,
      saved == EEXIST || saved == ENOTEMPTY ? "FILE_PATH_OCCUPIED" : "FILE_MOVE_PUBLICATION_REFUSED",
      restored ? "The destination was preserved and the original source returned" : "The original source remains in its claim; inspect without replaying"); return;
  }
  if (!strcmp(fault, "move-after-publish-crash")) _exit(104);
  if (!strcmp(fault, "move-directory-sync")) workspace_error("EIO", "Injected original move confirmation failure");
  if (fsync(stage) || fsync(source->parent) || fsync(destination->parent) || fsync(source->root) || fsync(destination->root)) workspace_errno();
  if (!path_scope_current(source) || !path_scope_current(destination) || path_entry_info(destination->parent, destination->name, &final_entry) || !path_identity_equal(&claimed, &final_entry))
    workspace_error("FILE_MOVE_SCOPE_CHANGED", "The original scope or moved identity changed after publication");
  path_retire_empty_stage(source, stage_name, &stage_info);
  path_move_receipt("published", "moved", 1, &final_entry, NULL, NULL); close(stage);
}
static void path_move_inspect(path_scope *source, path_scope *destination,
                              const char *source_root, const char *source_parent, const char *entry_witness,
                              const char *destination_root, const char *destination_parent, int claimed) {
  path_info target, old;
  if (claimed && path_original_directory(&source->root_info, source_root) && path_original_directory(&source->parent_info, source_parent) &&
      path_original_directory(&destination->root_info, destination_root) && path_original_directory(&destination->parent_info, destination_parent) &&
      path_scope_current(source) && path_scope_current(destination) && !path_entry_info(destination->parent, destination->name, &target) && path_original_directory(&target, entry_witness) &&
      (path_entry_info(source->parent, source->name, &old) ? errno == ENOENT : !path_original_directory(&old, entry_witness)))
    path_move_receipt("published", "moved", 0, &target, NULL, NULL);
  else path_move_receipt(claimed ? "claimed" : "prepared", "unknown", 0, NULL, "FILE_MOVE_UNCONFIRMED", "The original claimed move is not confirmed at its destination. Its request and claim are retained; no action was replayed.");
}

static const path_scope *path_delete_scope = NULL;
static int path_delete_stage = -1;
static path_info path_delete_claim;
static const char *path_delete_revision = NULL, *path_delete_fault = NULL;
static int path_delete_snapshot_barrier_used = 0;
static void path_delete_receipt(const char *phase, const char *effect, int confirmed,
                                const path_info *entry, const char *code, const char *message) {
  printf("{\"action\":\"delete\",\"phase\":\"%s\",\"filesystem\":\"%s\",\"durability\":\"%s\"", phase, effect, confirmed ? "confirmed" : "unconfirmed");
  if (entry) { printf(",\"deletedWitness\":"); path_witness_json(entry); }
  if (code) { printf(",\"code\":"); workspace_json_string(stdout, code); }
  if (message) { printf(",\"message\":"); workspace_json_string(stdout, message); }
  printf("}");
}
/* The original recursive walker calls this only for this finite exact producer.
 * Plain recursive files need no body scan; Notes acknowledge a saved revision. */
static void path_delete_snapshot(int parent, const char *name, const char *relative, const struct stat *before) {
  path_info root;
  if (!path_scope_current(path_delete_scope) || path_entry_info(path_delete_stage, "entry", &root) || !path_identity_equal(&root, &path_delete_claim))
    workspace_error("FILE_DELETE_CLAIM_CHANGED", "The original scope or exact claimed subtree changed; remaining material is retained");
  if (!S_ISREG(before->st_mode)) return;
  const int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  path_info original, current; struct stat hashed; char revision[72];
  if (fd < 0 || path_fd_info(fd, &original)) workspace_errno();
  if (!workspace_same_file(before, &original.file)) { close(fd); workspace_error("FILE_DELETE_ENTRY_CHANGED", "The original claimed regular entry changed before history observation"); }
  unsigned char prefix[8]; ssize_t length;
  do { length = pread(fd, prefix, sizeof(prefix), 0); } while (length < 0 && errno == EINTR);
  if (length < 0) workspace_errno();
  FILE *output = fdopen(dup(3), "w"); if (!output) workspace_errno();
  fprintf(output, "{\"phase\":\"snapshot\",\"suffix\":"); workspace_json_string(output, relative);
  fprintf(output, ",\"entry\":"); path_witness_output(output, &original); fprintf(output, ",\"prefixHex\":\"");
  for (ssize_t index = 0; index < length; index++) fprintf(output, "%02x", prefix[index]);
  fprintf(output, "\"}\n"); if (fflush(output) || fclose(output)) workspace_errno();
  char response[80]; size_t size = 0;
  for (;;) {
    char byte; const ssize_t count = read(4, &byte, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count != 1 || size >= sizeof(response) - 1) workspace_error("FILE_DELETE_HISTORY_UNCONFIRMED", "The original Host did not confirm the exact claimed entry snapshot");
    if (byte == '\n') break;
    response[size++] = byte;
  }
  response[size] = 0;
  if (strcmp(response, "G") && !(size == 72 && response[0] == 'S' && !strncmp(response + 1, "sha256:", 7) && strspn(response + 8, "0123456789abcdef") == 64))
    workspace_error("FILE_DELETE_HISTORY_UNCONFIRMED", "The original snapshot acknowledgement is invalid");
  if (!path_delete_snapshot_barrier_used && !strcmp(path_delete_fault, "after-delete-snapshot-barrier")) {
    path_delete_snapshot_barrier_used = 1; commit_barrier(1, 5, 6, "after-delete-snapshot");
  }
  const char *expected = response[0] == 'S' ? response + 1 : !*relative ? path_delete_revision : NULL;
  if (expected && (!workspace_fd_revision(fd, revision, &hashed, original.file.st_size) || strcmp(revision, expected))) {
    close(fd); workspace_error("FILE_DELETE_ENTRY_CHANGED", "The original Note or requested file body changed after its snapshot; it was retained");
  }
  if (path_fd_info(fd, &current) || !path_same_entry(&original, &current) || path_entry_info(parent, name, &current) || !path_same_entry(&original, &current) || !path_scope_current(path_delete_scope)) {
    close(fd); workspace_error("FILE_DELETE_ENTRY_CHANGED", "The exact original claimed entry or scope changed before unlink");
  }
  close(fd);
}
static void path_delete(path_scope *source, const char *stage_name, const char *root_witness,
                        const char *parent_witness, const char *entry_witness, const char *kind,
                        const char *expected_revision, int recursive, const char *fault) {
  path_info entry;
  if (!source->root_info.birthtime_known || !source->parent_info.birthtime_known) { path_delete_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_GENERATION_UNAVAILABLE", "The original scope generation is unavailable"); return; }
  if (!path_original_directory(&source->root_info, root_witness) || !path_original_directory(&source->parent_info, parent_witness) || !path_scope_current(source)) { path_delete_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_SCOPE_CONFLICT", "The original root or parent changed"); return; }
  if (path_entry_info(source->parent, source->name, &entry)) { path_delete_receipt("settled", "not-applied", 1, NULL, "FILE_DELETE_SOURCE_CONFLICT", "The exact original source entry is unavailable"); return; }
  if (!entry.birthtime_known) { path_delete_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_GENERATION_UNAVAILABLE", "The original source generation is unavailable"); return; }
  if (strcmp(path_kind(&entry), kind) || (!strcmp(kind, "directory") ? !path_original_directory(&entry, entry_witness) : !path_witness_equal(&entry, entry_witness))) { path_delete_receipt("settled", "not-applied", 1, NULL, "FILE_DELETE_SOURCE_CONFLICT", "The exact original source generation changed"); return; }
  if (!S_ISREG(entry.file.st_mode) && !S_ISDIR(entry.file.st_mode) && !S_ISLNK(entry.file.st_mode)) { path_delete_receipt("settled", "not-applied", 1, NULL, "FILE_DELETE_KIND_UNSUPPORTED", "Delete requires one ordinary file, directory or symlink entry"); return; }
  if (S_ISREG(entry.file.st_mode)) {
    const int fd = openat(source->parent, source->name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    struct stat hashed; char revision[72];
    if (fd < 0) workspace_errno();
    const int exact = workspace_fd_revision(fd, revision, &hashed, entry.file.st_size) && workspace_same_file(&entry.file, &hashed) && !strcmp(revision, expected_revision);
    close(fd);
    if (!exact) { path_delete_receipt("settled", "not-applied", 1, NULL, "FILE_DELETE_REVISION_CONFLICT", "The original regular file body revision changed"); return; }
  }
  if (mkdirat(source->parent, stage_name, 0700)) workspace_errno();
  const int stage = openat(source->parent, stage_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  path_info stage_info;
  if (stage < 0 || path_fd_info(stage, &stage_info) || fsync(stage) || fsync(source->parent)) workspace_errno();
  if (!stage_info.birthtime_known) { close(stage); path_delete_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_GENERATION_UNAVAILABLE", "The original private claim generation is unavailable"); return; }
  path_offer_move("staged", &stage_info, &entry);
  if (!strcmp(fault, "delete-after-stage-crash")) _exit(111);
  commit_barrier(!strcmp(fault, "before-delete-claim-barrier"), 5, 6, "before-delete-claim");
  if (!path_scope_current(source)) { close(stage); path_delete_receipt("settled", "not-applied", 1, NULL, "FILE_PATH_SCOPE_CONFLICT", "The original scope changed before claim"); return; }
  path_info visible;
  if (path_entry_info(source->parent, stage_name, &visible) || !path_identity_equal(&visible, &stage_info)) workspace_error("FILE_DELETE_CLAIM_CHANGED", "The original private claim container changed");
  if (path_move_between(source->parent, source->name, stage, "entry")) {
    const int saved = errno; close(stage);
    path_delete_receipt("settled", "not-applied", 1, NULL, saved == ENOSYS || saved == ENOTSUP || saved == EOPNOTSUPP ? "FILE_PATH_NATIVE_UNSUPPORTED" : "FILE_DELETE_CLAIM_REFUSED", "The original source was not claimed; no shell fallback was attempted"); return;
  }
  workspace_write_published = 1;
  path_info claimed;
  if (path_entry_info(stage, "entry", &claimed)) workspace_errno();
  if (!path_identity_equal(&entry, &claimed) || strcmp(path_kind(&claimed), kind) || (S_ISREG(claimed.file.st_mode) && (entry.file.st_size != claimed.file.st_size || workspace_mtime(&entry.file) != workspace_mtime(&claimed.file)))) {
    const int restored = path_return_claim(source, stage, &claimed); close(stage);
    path_delete_receipt(restored ? "settled" : "claimed", restored ? "not-applied" : "unknown", restored, NULL, "FILE_DELETE_SOURCE_CONFLICT", "A late source replacement or edit was retained without deletion"); return;
  }
  if (fsync(stage) || fsync(source->parent) || path_fd_info(stage, &stage_info)) workspace_errno();
  /* The existing error reporter can name the actual retained claim even if an
   * external tool moves its parent after G2. This changes only this helper cwd. */
  if (fchdir(stage)) workspace_errno();
  workspace_retained = "entry"; workspace_claim_root = source->root_path;
  if (!strcmp(fault, "delete-after-claim-crash")) _exit(112);
  path_offer_move("claimed", &stage_info, &claimed);
  if (!strcmp(fault, "delete-after-claim-ack-crash")) _exit(113);
  commit_barrier(!strcmp(fault, "before-delete-unlink-barrier"), 5, 6, "before-delete-unlink");
  path_delete_scope = source; path_delete_stage = stage; path_delete_claim = claimed;
  path_delete_revision = S_ISREG(claimed.file.st_mode) ? expected_revision : NULL; path_delete_fault = fault;
  if (S_ISDIR(claimed.file.st_mode) && !recursive) {
    path_delete_snapshot(stage, "entry", "", &claimed.file);
    if (unlinkat(stage, "entry", AT_REMOVEDIR)) {
      const int saved = errno, restored = saved == ENOTEMPTY || saved == EEXIST ? path_return_claim(source, stage, &claimed) : 0;
      if (restored) workspace_retained = NULL;
      close(stage); if (restored) path_retire_empty_stage(source, stage_name, &stage_info);
      path_delete_receipt(restored ? "settled" : "claimed", restored ? "not-applied" : "unknown", restored, NULL, "FILE_DELETE_DIRECTORY_NOT_EMPTY", "Only an empty original directory was authorized; remaining material is retained"); return;
    }
  } else {
    workspace_delete_before_file = path_delete_snapshot;
    workspace_delete(stage, "entry"); workspace_delete_before_file = NULL;
  }
  workspace_retained = NULL;
  if (!strcmp(fault, "delete-after-unlink-crash")) _exit(114);
  if (fsync(stage) || fsync(source->parent)) workspace_errno();
  if (!path_scope_current(source)) { close(stage); path_delete_receipt("deleted", "unknown", 0, NULL, "FILE_PATH_SCOPE_CONFLICT", "The original entry was removed but its scope changed before confirmation"); return; }
  close(stage); path_retire_empty_stage(source, stage_name, &stage_info);
  path_delete_receipt("deleted", "deleted", 1, &claimed, NULL, NULL);
}

static int workspace_path_operation(int argc, char **argv) {
  if (argc < 2 || strcmp(argv[1], "--workspace-path")) return 0;
  if (argc == 5 && !strcmp(argv[2], "related")) { path_directory_relation(argv[3], argv[4]); return 1; }
  if (argc == 13 && !strcmp(argv[2], "delete")) {
    const char *stage = argv[5];
    if (strlen(stage) > NAME_MAX || strncmp(stage, ".agentmux-delete-", 17) || strlen(stage + 17) != 64 || strspn(stage + 17, "0123456789abcdef") != 64) workspace_error("FILE_DELETE_INVALID_STAGE", "The exact original private claim name is required");
    path_scope source = path_open_scope(argv[3], argv[4], 0);
    fprintf(stderr, "AGENTMUX_WORKSPACE_READY\n"); fflush(stderr);
    size_t length; unsigned char *input = workspace_input(STDIN_FILENO, &length); free(input);
    path_delete(&source, stage, argv[6], argv[7], argv[8], argv[9], argv[10], !strcmp(argv[11], "1"), argv[12]);
    path_scope_close(&source); return 1;
  }
  if (argc == 16 && (!strcmp(argv[2], "move") || !strcmp(argv[2], "move-inspect"))) {
    validate_relative_path(argv[7]);
    if (strchr(argv[7], '/')) workspace_error("FILE_MOVE_INVALID_STAGE", "An exact direct claim name is required");
    path_scope source = path_open_scope(argv[3], argv[4], 0), destination = path_open_scope(argv[5], argv[6], 0);
    fprintf(stderr, "%s\n", "AGENTMUX_WORKSPACE_READY"); fflush(stderr);
    size_t input_length; unsigned char *input = workspace_input(STDIN_FILENO, &input_length); free(input);
    if (!strcmp(argv[2], "move")) path_move(&source, &destination, argv[7], argv[8], argv[9], argv[10], argv[11], argv[12], argv[13], argv[15]);
    else path_move_inspect(&source, &destination, argv[8], argv[9], argv[10], argv[12], argv[13], !strcmp(argv[14], "claimed"));
    path_scope_close(&destination); path_scope_close(&source); return 1;
  }
  if (argc < 5 || (strcmp(argv[2], "stat") && strcmp(argv[2], "stat-revision") && strcmp(argv[2], "mkdir") && strcmp(argv[2], "inspect")))
    workspace_error("FILE_PATH_INVALID_REQUEST", "Invalid original path helper action");
  const int include_revision = !strcmp(argv[2], "stat-revision"), observe = !strcmp(argv[2], "stat") || include_revision, inspect = !strcmp(argv[2], "inspect");
  if (observe ? argc != 5 && argc != 6 : argc != 10) workspace_error("FILE_PATH_INVALID_REQUEST", "Invalid original path helper arguments");
  path_scope scope = path_open_scope(argv[3], argv[4], observe);
  fprintf(stderr, "AGENTMUX_WORKSPACE_READY\n"); fflush(stderr);
  size_t length; unsigned char *input = workspace_input(STDIN_FILENO, &length); free(input);
  if (observe) path_stat(&scope, include_revision, argc == 6 ? argv[5] : "");
  else {
    const char *stage = argv[5], *digest = argv[6], *root_witness = argv[7], *parent_witness = argv[8];
    if (strlen(stage) > NAME_MAX || strncmp(stage, ".agentmux-mkdir-", 16) || strchr(stage, '/') || strlen(digest) != 64 || strspn(digest, "0123456789abcdef") != 64)
      workspace_error("FILE_PATH_INVALID_REQUEST", "The exact private producer and original digest are required");
    if (strcmp(stage + 16, digest)) workspace_error("FILE_PATH_INVALID_REQUEST", "The original producer name does not match its intent digest");
    if (inspect) path_mkdir_inspect(&scope, root_witness, parent_witness, argv[9]);
    else path_mkdir(&scope, stage, root_witness, parent_witness, argv[9]);
  }
  path_scope_close(&scope); return 1;
}
