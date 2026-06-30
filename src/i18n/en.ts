const dict = {
	"sync.no_tty":
		"No-TTY output detected (pm2/nohup/systemd) — progress bar disabled, falling back to line-by-line logging.",
	"sync.performance":
		"Performance: parallel={parallel} | batchSize={batchSize} | flushIntervalMs={flushIntervalMs}{extra}",
	"sync.performance.full": " | --full (forced re-dump)",
	"sync.performance.copyindexes": " | copyIndexes=on",
	"sync.performance.copyviews": " | copyViews={n}",
	"sync.shutdown_received":
		"Received {signal} — shutting down and saving checkpoints...",
	"sync.shutdown_exceeded": "Shutdown exceeded {shutdownMs}ms — forced exit.",
	"sync.opening_watch":
		"Opening watch on {count} collection(s) — events: {events}...",
	"sync.stophint.tty": "stop: Ctrl+C (saves the checkpoint)",
	"sync.stophint.container":
		"stop: docker stop (saves the checkpoint, do not remove)",
	"sync.ready":
		"SYNC READY: {ready}/{total} up to date | {resumed} resumed | {dumps} dump | {docs} docs | failures: {failures}{extra}",
	"sync.ready.indexes":
		" | indexes: +{created} ({skipped} already existed, {failed} failures)",
	"sync.ready.views":
		" | views: +{created} ({updated} updated, {skipped} unchanged, {failed} failures)",
	"sync.container_note":
		"# while this container runs, the replica stays in REAL TIME.\n# the state (resume token + frontiers) lives in the DESTINATION Mongo, not in\n# the container — so `docker stop` and bringing it up again RESUMES where it left off,\n# without losing anything. That's why you do NOT need to remove/recreate the container; and\n# avoid `kill -9`/OOM (then the final checkpoint is not saved: loses ~5s,\n# re-applied idempotently on the next start).",
	"migrate.restore_failed": "Failed to restore collections: {list}",
	"migrate.retry_cold": "Retrying set cold stats on failed collections",
	"migrate.retry_drop": "Retrying drop failed collections",
	"ttl.err_uri_db": "CLI mode requires --uri and --db",
	"ttl.err_expire": "CLI mode requires --expire",
	"ttl.err_field_derive_exclusive":
		"--field and --derive-from-id are mutually exclusive",
	"ttl.err_field_or_derive": "CLI mode requires --field or --derive-from-id",
	"ttl.err_collections_all_exclusive":
		"--collections and --all are mutually exclusive",
	"ttl.err_collections_or_all": "CLI mode requires --collections or --all",
	"ttl.applying":
		"Applying TTL on {count} collection(s) with parallelism {parallel}...",
	"ttl.applied_coll": "TTL on {name}: {field} expires in {seconds}s{derived}",
	"ttl.derived_frag": " (_created on {count} docs)",
	"ttl.failed_coll": "TTL FAILED on {name}: {error}",
	"ttl.summary": "TTL applied on {applied}/{total} collection(s){extra}",
	"ttl.summary_failed": " — {failed} FAILED",
	"compose.base_not_found": "✗ Could not find {file} in the current directory.",
	"compose.run_at_root": " Run it at the root of the pulsar repo.",
	"compose.title": "PULSAR COMPOSE — new instance",
	"compose.existing_instances": "Existing instances:",
	"compose.none": "none",
	"compose.ram_line":
		"RAM: total {total}G · in use (OS) {used}G · committed for pulsar {committed}G",
	"compose.cpu_line": "CPU: {cores} core(s) · committed {committed}",
	"compose.sync_configs_found": "Sync configs found:",
	"compose.config_item": "  {n}) {file} → destination: {dest}",
	"compose.ignored_for_sync": "  (ignored for sync: {list})",
	"compose.prompt_config": "Config (list number or path)",
	"compose.prompt_config_hint": " — MUST point to another destination:",
	"compose.config_required": "Config is required. Aborted.",
	"compose.config_not_exist":
		"⚠ {path} does not exist yet — create it before bringing up (own URI/destination).",
	"compose.prompt_suffix": "Instance suffix",
	"compose.prompt_suffix_hint": " (e.g.: 2 → pulsar-sync-2):",
	"compose.suffix_required": "Suffix is required. Aborted.",
	"compose.suggested_resources": "Suggested resources",
	"compose.suggested_resources_hint": " (available − in use → recommended)",
	"compose.resource_mode_hint":
		"  [1] use recommended (Enter)   [2] enter manually",
	"compose.prompt_option": "Option:",
	"compose.prompt_cpus": "cpus (cores):",
	"compose.generated": "✓ Generated {file}",
	"compose.generated_detail":
		"  container {container} · config {config} · logs {logs} · {mem}m/{cpus}cpu",
	"compose.confirm_up":
		"Bring it up now (docker compose -f {file} up -d --build)?",
	"compose.up_ok": "\n✓ pulsar-sync-{suffix} is up.",
	"compose.up_ok_logs": " Logs: docker logs -f pulsar-sync-{suffix}",
	"compose.up_fail":
		"\n✗ Failed to bring up — check Docker and the generated compose.",
	"compose.up_later":
		"\nWhenever you want: docker compose -f {file} up -d --build",
	"dump.start_resume_suffix": " (resuming from _id<{frontier})",
	"dump.start": "dump:start | collection: {coll} | total: {total}{resume}",
	"dump.progress":
		"dump:progress | collection: {coll} | {processed}/{total} | skip {skip} upd {upd} ins {ins}",
	"dump.truncated_error":
		"truncated dump: the cursor ended early and {remaining} docs are still missing below _id<{frontier} after {maxRetries} attempts (collection: {coll}, processed: {processed})",
	"dump.short_cursor":
		"dump:short-cursor | collection: {coll} | cursor ended early, {remaining} missing | resuming from _id<{frontier} | attempt {attempt}/{maxRetries}",
	"dump.retry":
		"dump:retry | collection: {coll} | attempt {attempt}/{maxRetries} | resuming from _id<{frontier} | waiting {wait}ms | cause: {reason}",
	"views.part_created": "created {created}",
	"views.part_updated": "updated {updated}",
	"views.part_skipped": "already identical {skipped}",
	"views.part_failed": "FAILED {failed}",
	"views.summary": "views | {parts}",
	"views.failure": "view:failure | {name} | {reason}",
	"views.list_migrate_failed":
		"views | failed to list/migrate (contained): {reason}",
	"indexes.copy_failed": "[{coll}] index copy failed: {reason}",
	"indexes.part_created": "{created} indexes created",
	"indexes.part_existed": "{skipped} already existed",
	"indexes.part_failed": "{failed} FAILED ({names})",
	"indexes.summary": "[{coll}] {parts}",
	"resume.token_invalid":
		"RESUME:db.watch global token invalid/expired — re-dumping everything",
	"watch.reopening": "WATCH:db.watch {message}. Reopening in 5s...",
	"watch.delete_failed": "watch:delete failed | collection: {coll} | _id: {id}",
	"watch.delete": "watch:delete | collection: {coll} | _id: {id}",
	"dump.synced":
		"Collection [ {coll} ] synced — {total} docs | {skipped} skipped | {updated} updated | {inserted} inserted",
	"dump.collection_failed": "Dump failed for collection [ {coll} ]: {message}",
	"views.dest_is_collection_error":
		'destination already has a COLLECTION "{name}" (not a view) — skipping to avoid destroying data',
	"ttl.duration.invalid_number": "Invalid duration: {input} (must be > 0)",
	"ttl.duration.invalid_format":
		"Invalid duration: \"{input}\". Use <number><unit>, e.g.: 30d, 1h, 3mo. Units: s/sec/seconds, min/minutes, h/hours, d/days, w/weeks, mo/months, y/years. 'm' alone is forbidden (ambiguous minute/month): use 'min' or 'mo'.",
	"ttl.duration.invalid_value": 'Invalid duration: "{input}" (must be > 0)',
	"ttl.resolve.field_derive_exclusive":
		'Collection "{name}": "field" and "deriveFromId" are mutually exclusive',
	"ttl.resolve.no_field":
		'Collection "{name}" has no TTL field defined: provide "field" (existing Date field) or "deriveFromId: true"',
	"ttl.resolve.no_expire":
		'Collection "{name}" has no "expire"/"expireAfterSeconds" defined',
	"panel.bar.format":
		"{collection} ⟬{bar}⟭ {percentage}% | {value}/{total} | ↷ {skip} skip | ✎ {upd} upd | ⊕ {ins} ins | ⧖ {duration_formatted}",
	"status.header": "  SYNC · INITIAL DUMP",
	"status.footer":
		"  resumed (no dump, kept by watch): {resuming}  ·  dump finished: {done}/{planned}  ·  in progress: {active}  ·  total: {total}",
	"panel.title": "PULSAR · INITIAL SYNC COMPLETE",
	"panel.mode": "MODE: real time · replicating changes live",
	"panel.collections_ok": "Collections up to date .... {ok}/{total}",
	"panel.resumed": "  ↳ resumed (delta) ....... {resumed}",
	"panel.dumped": "  ↳ full dump ............. {dumped}{dumpedLabel}",
	"panel.dumped_names": "  ({names})",
	"panel.failed": "  ↳ FAILED (re-dump) ...... {count} ({names})",
	"panel.docs_dumped": "Docs copied in dump ....... {docs}",
	"panel.duration": "Duration .................. {dur}",
	"panel.indexes":
		"Indexes ... created: {created} · already existed: {skipped}{fLabel}",
	"panel.indexes_failed": " · failed: {count} ({colls})",
	"panel.views":
		"Views ..... created: {created} · updated: {updated} · unchanged: {skipped}{fLabel}",
	"panel.views_failed": " · failed: {count} ({names})",
	"watch.heartbeat.head": "──── PULSAR · WATCH ACTIVE ──── uptime {uptime}",
	"watch.heartbeat.idle": "{head} · 0 events (source quiet)",
	"watch.heartbeat.top": "   most active: {top}{rest}",
	"watch.heartbeat.top_rest": "  (+{rest})",
	"watch.heartbeat.events":
		" events: {total}  (ins {insert} · upd {update} · rep {replace} · del {delete})",
	"load.report":
		"INITIAL LOAD COMPLETE: {count} collections | start {start} | end {end} | total {total}",
	"cli.title.fallback": "«« PULSAR »»",
	"progressbar.default_label": "Progress",
	"yml.error.not_found": "File not found on path: {path}",
	"yml.error.empty": "YML file is empty or malformed",
	"migrate.tools_missing":
		"Binary(ies) not found in PATH: {missing}. migrate needs mongodb-database-tools. Install it and try again. Ubuntu: download the .deb at https://www.mongodb.com/try/download/database-tools (e.g.: sudo apt install -y ./mongodb-database-tools-<codename>-x86_64-<version>.deb). Confirm with: mongodump --version",
	"collections.filterfile_unreadable":
		"Could not read filterFile: {filterFile}",
	"collections.none_to_watch": "No collections to watch on file: {ymlPath}",
	"conn.uri_empty": "Mongo URI not declared or is empty: uri={uri}",
	"conn.connecting": "Connecting to MongoDB...",
	"conn.connected": "Connected to {source} MongoDB!",
	"conn.unreachable":
		"Could not reach MongoDB ({source}). Check: 1) your IP is in the Atlas Network Access (IP allowlist); 2) outbound TCP on 27017 is not blocked; 3) credentials/URI. Details in logs/error.log",
} as const;

export default dict;
