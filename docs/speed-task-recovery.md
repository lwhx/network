# Durable acceleration task recovery

Acceleration deployments and managed-domain deletions persist a task journal in SQLite. Startup only reads
unfinished tasks. Recovery is an explicit rollback action; it never resumes a
forward deployment and completed deployments cannot be rolled back using this API.

## Service contract

`new SpeedTaskStore({store: sqliteStore})` creates its own journal tables and uses
`sqliteStore.secretBox` to encrypt operation snapshots. Inject it as
`new SpeedDeployService({cloudflareClient, dnsRecordsService, speedTaskStore})`.

Every task method requires the currently selected credentials to include a stable
local `accountId`, email and API key. Task lookups match that exact account ID;
they never fall back to the first saved account or an email match. Omitting the
journal preserves the previous in-memory service behavior for legacy callers.

| Method | Result / behavior |
|---|---|
| `listTasks({zoneId?} = {})` | Synchronous array of safe tasks for selected account |
| `await inspectTask(id)` | Safe task plus per-step current-versus-snapshot classifications; only remote reads |
| `await recoverTask(id)` | Safe task plus `rollback: {status: complete/incomplete, steps}`; explicit guarded rollback |
| `resolveManualTask(id)` | Synchronous safe task; acknowledges manual handling and releases block; no remote writes |
| `speedTaskStore.hasUnresolvedAccountTasks(accountId)` | Boolean for saved-account deletion guard |

Deployment and deletion successes include `taskId`; errors include `error.taskId`
and, where rollback ran, `error.rollback`. Snapshot values, origin configuration,
DNS record contents and customer metadata are never returned by task endpoints.
Task errors and recovery messages use fixed text rather than raw Cloudflare errors.

## States and classifications

| Task state | Meaning |
|---|---|
| `running` | Worker performing deployment or deletion still owns the scope |
| `recovering` | Worker performing explicit rollback still owns the scope |
| `manual_needed` | Interrupted worker, unknown write, unsafe changed resource, or incomplete rollback; zone remains blocked |
| `completed` | Deployment or deletion succeeded; terminal |
| `rolled_back` | No changes were made, or every registered step safely restored; terminal |
| `manual_resolved` | User explicitly acknowledged checked manual handling; terminal, not proof of automatic rollback |

`recoverable` is true only for unfinished tasks without a live worker.
Tasks expose `kind` (`deployment` or `deletion`). `steps` contain `resource`,
`type` (`dns`, `fallback`, `hostname`, `delete_dns`, `delete_hostname`) and
`status` (including `pending`, `deleted`, and `rejected` for deletion).
Inspection additionally returns `classification`: `applied`, `original`,
`restored`, `external_change`, `unknown_write`, `unconfirmed_creation`, or
`unreadable`. Recovery audits contain fixed action, time and task state.

Manual resolution requires a successful inspection of the current journal
revision. Any subsequent journal mutation invalidates that inspection. The UI
must ask for an explicit manual acknowledgement and explain that a previously
unknown remote write may still execute later; inspecting an original-looking
resource does not prove that an outstanding request was rejected.

## Managed-domain deletion

Deletion preflights both DNS and custom hostname reads and records an encrypted
`kind: deletion` journal before removing resources. Each step checks the captured
identity/configuration, saves `pending` before DELETE, then confirms absence
before recording `deleted`. A rejected request stops further deletions; partial
or uncertain outcomes retain the scope lock with `manual_needed`. Error results
include numeric `summary` counts for succeeded, failed, unknown and skipped steps.

Deletion inspection is read-only. Recovery never recreates deleted resources;
the UI offers only inspection and explicit manual acknowledgement for deletion
tasks. A pending deletion remains uncertain even when the resource is absent.
Successful inspection of the latest revision is required before acknowledgement.
Account deletion is blocked by unfinished tasks and active scope locks. Task
creation verifies that the saved account still exists inside its SQLite write
transaction, closing the race with a delayed request body and account deletion.

## Journal and concurrency

Before each Cloudflare write, the encrypted journal records a descriptor with
type, scope, label, before state, expected state, request body, confirmation and
step status. It captures only editable operation fields and resource identity;
credential-shaped keys are excluded recursively, including customer metadata.
If excluded fields prevent an exact comparison, the resource requires manual
review rather than an unsafe partial restoration. Certificate status changes and
other read-only Cloudflare fields are excluded from configuration comparisons.

Successful write confirmations are saved before proceeding. A rollback intention
(`rollback_pending`) is saved before compensation and its confirmed result after
compensation. Recovery reconstructs operations from the descriptors and works in
reverse order. DNS and hostname resource IDs must match. External edits or
replacement identities are preserved. Missing existing resources are never
recreated. A matching shape alone does not establish ownership of a creation.

Any step still marked `pending` or `rollback_pending` is uncertain regardless of
whether a current read matches the original or expected snapshot. It requires
manual review. An unknown write is neither automatically retried nor considered
complete. Confirmed steps can be independently restored while other uncertain
steps keep the task blocked.

SQLite `BEGIN IMMEDIATE` and a unique `(account_id, zone_id)` scope lock exclude
new deployments, managed-domain deletions and concurrent recoveries, including
separate SQLite connections. An unresolved task retains its lock until safe
rollback or explicit manual resolution. Worker writes verify the owner token
inside each SQLite transaction; a former worker cannot update a reclaimed task.

Opening another service never marks live tasks interrupted. Linux boot identity,
PID namespace and process start ticks detect a dead same-namespace worker and
PID reuse. A 15-second heartbeat maintains a 90-second lease for workers in a
foreign PID namespace. Across container restarts with a new namespace, recovery
may therefore wait up to 90 seconds; active foreign workers retain their lease.
A changed kernel boot identity proves the former worker is gone. When Linux
process identity is unavailable, process existence and the lease provide a
conservative fallback.

SQLite and Cloudflare cannot commit atomically. The journal deliberately retains
uncertainty at those boundaries. Cloudflare does not provide a conditional update
for these resources: configuration comparison happens immediately before the
compensating request, so an external actor racing that request remains an API
limitation. Scope locks serialize panel actions, not independent Cloudflare users.

## Verification

`node --test test/speed-task-recovery.test.js test/speed-deploy-rollback.test.js`
checks actual child-process SIGKILL interruption, deterministic pending and
confirmed checkpoints, no startup remote writes, encrypted metadata, exact
account scope, cross-connection concurrency, lease behavior, external replacement
preservation, manual-acknowledgement revision guards and compensation intentions.
Existing SSL-mode preservation and legacy rollback checks remain covered.

## Upgrade and operation history

Keep the existing SQLite database and encryption key on upgrade; tables are
created automatically. Pre-upgrade in-memory history and task snapshots cannot
be reconstructed. Operation history retains the newest 3000 sanitized entries,
with account, zone, module, status and UTC date/time filtering and pagination.
Partial and unknown outcomes remain distinct. Clearing history does not clear
task journals or release locks. Snapshots are encrypted; API responses expose
only safe summaries and classifications.
