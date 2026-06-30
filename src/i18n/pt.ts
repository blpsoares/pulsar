const dict = {
	"sync.no_tty":
		"Saída sem TTY detectada (pm2/nohup/systemd) — barra de progresso desativada, usando log linha-a-linha.",
	"sync.performance":
		"Performance: parallel={parallel} | batchSize={batchSize} | flushIntervalMs={flushIntervalMs}{extra}",
	"sync.performance.full": " | --full (re-dump forçado)",
	"sync.performance.copyindexes": " | copyIndexes=on",
	"sync.performance.copyviews": " | copyViews={n}",
	"sync.shutdown_received":
		"Recebido {signal} — encerrando e salvando checkpoints...",
	"sync.shutdown_exceeded": "Shutdown excedeu {shutdownMs}ms — saída forçada.",
	"sync.opening_watch":
		"Abrindo watch em {count} collection(s) — eventos: {events}...",
	"sync.stophint.tty": "parar: Ctrl+C (salva o checkpoint)",
	"sync.stophint.container":
		"parar: docker stop (salva o checkpoint, não remova)",
	"sync.ready":
		"SYNC PRONTO: {ready}/{total} em dia | {resumed} retomadas | {dumps} dump | {docs} docs | falhas: {failures}{extra}",
	"sync.ready.indexes":
		" | índices: +{created} ({skipped} já existiam, {failed} falhas)",
	"sync.ready.views":
		" | views: +{created} ({updated} atualizadas, {skipped} iguais, {failed} falhas)",
	"sync.container_note":
		"# enquanto este container roda, a réplica fica em TEMPO REAL.\n# o estado (resume token + fronteiras) vive no Mongo de DESTINO, não no\n# container — então `docker stop` e subir de novo RETOMA de onde parou,\n# sem perder nada. Por isso NÃO precisa remover/recriar o container; e\n# evite `kill -9`/OOM (aí o checkpoint final não é salvo: perde ~5s,\n# re-aplicados idempotente no próximo start).",
	"migrate.restore_failed": "Falha ao restaurar collections: {list}",
	"migrate.retry_cold":
		"Retentando setar estado cold nas collections que falharam",
	"migrate.retry_drop": "Retentando dropar collections que falharam",
	"ttl.err_uri_db": "Modo CLI exige --uri e --db",
	"ttl.err_expire": "Modo CLI exige --expire",
	"ttl.err_field_derive_exclusive":
		"--field e --derive-from-id são mutuamente exclusivos",
	"ttl.err_field_or_derive": "Modo CLI exige --field ou --derive-from-id",
	"ttl.err_collections_all_exclusive":
		"--collections e --all são mutuamente exclusivos",
	"ttl.err_collections_or_all": "Modo CLI exige --collections ou --all",
	"ttl.applying":
		"Aplicando TTL em {count} collection(s) com paralelismo {parallel}...",
	"ttl.applied_coll": "TTL em {name}: {field} expira em {seconds}s{derived}",
	"ttl.derived_frag": " (_created em {count} docs)",
	"ttl.failed_coll": "TTL FALHOU em {name}: {error}",
	"ttl.summary": "TTL aplicado em {applied}/{total} collection(s){extra}",
	"ttl.summary_failed": " — {failed} FALHARAM",
	"compose.base_not_found": "✗ Não achei {file} no diretório atual.",
	"compose.run_at_root": " Rode na raiz do repo do pulsar.",
	"compose.title": "PULSAR COMPOSE — nova instância",
	"compose.existing_instances": "Instâncias existentes:",
	"compose.none": "nenhuma",
	"compose.ram_line":
		"RAM: total {total}G · em uso (SO) {used}G · comprometida p/ pulsar {committed}G",
	"compose.cpu_line": "CPU: {cores} núcleo(s) · comprometidos {committed}",
	"compose.sync_configs_found": "Configs de sync encontradas:",
	"compose.config_item": "  {n}) {file} → destino: {dest}",
	"compose.ignored_for_sync": "  (ignoradas p/ sync: {list})",
	"compose.prompt_config": "Config (nº da lista ou caminho)",
	"compose.prompt_config_hint": " — DEVE apontar p/ outro destino:",
	"compose.config_required": "Config obrigatória. Abortado.",
	"compose.config_not_exist":
		"⚠ {path} ainda não existe — crie antes de subir (URI/destino próprios).",
	"compose.prompt_suffix": "Sufixo da instância",
	"compose.prompt_suffix_hint": " (ex.: 2 → pulsar-sync-2):",
	"compose.suffix_required": "Sufixo obrigatório. Abortado.",
	"compose.suggested_resources": "Recursos sugeridos",
	"compose.suggested_resources_hint": " (disponível − em uso → recomendado)",
	"compose.resource_mode_hint":
		"  [1] usar recomendados (Enter)   [2] inserir manualmente",
	"compose.prompt_option": "Opção:",
	"compose.prompt_cpus": "cpus (núcleos):",
	"compose.generated": "✓ Gerado {file}",
	"compose.generated_detail":
		"  container {container} · config {config} · logs {logs} · {mem}m/{cpus}cpu",
	"compose.confirm_up": "Subir agora (docker compose -f {file} up -d --build)?",
	"compose.up_ok": "\n✓ pulsar-sync-{suffix} no ar.",
	"compose.up_ok_logs": " Logs: docker logs -f pulsar-sync-{suffix}",
	"compose.up_fail":
		"\n✗ Falha ao subir — verifique o Docker e o compose gerado.",
	"compose.up_later": "\nQuando quiser: docker compose -f {file} up -d --build",
	"dump.start_resume_suffix": " (retomando de _id<{frontier})",
	"dump.start": "dump:start | collection: {coll} | total: {total}{resume}",
	"dump.progress":
		"dump:progress | collection: {coll} | {processed}/{total} | skip {skip} upd {upd} ins {ins}",
	"dump.truncated_error":
		"dump truncado: o cursor encerrou cedo e ainda faltam {remaining} docs abaixo de _id<{frontier} após {maxRetries} tentativas (collection: {coll}, processados: {processed})",
	"dump.short_cursor":
		"dump:short-cursor | collection: {coll} | cursor encerrou cedo, faltam {remaining} | retomando de _id<{frontier} | tentativa {attempt}/{maxRetries}",
	"dump.retry":
		"dump:retry | collection: {coll} | tentativa {attempt}/{maxRetries} | retomando de _id<{frontier} | aguardando {wait}ms | causa: {reason}",
	"views.part_created": "criadas {created}",
	"views.part_updated": "atualizadas {updated}",
	"views.part_skipped": "já iguais {skipped}",
	"views.part_failed": "FALHARAM {failed}",
	"views.summary": "views | {parts}",
	"views.failure": "view:falha | {name} | {reason}",
	"views.list_migrate_failed":
		"views | falha ao listar/migrar (contido): {reason}",
	"indexes.copy_failed": "[{coll}] cópia de índices falhou: {reason}",
	"indexes.part_created": "{created} índices criados",
	"indexes.part_existed": "{skipped} já existiam",
	"indexes.part_failed": "{failed} FALHOU ({names})",
	"indexes.summary": "[{coll}] {parts}",
	"resume.token_invalid":
		"RESUME:db.watch token global inválido/expirado — re-dump de tudo",
	"watch.reopening": "WATCH:db.watch {message}. Reabrindo em 5s...",
	"watch.delete_failed": "watch:delete falhou | collection: {coll} | _id: {id}",
	"watch.delete": "watch:delete | collection: {coll} | _id: {id}",
	"dump.synced":
		"Collection [ {coll} ] sincronizada — {total} docs | {skipped} pulados | {updated} atualizados | {inserted} inseridos",
	"dump.collection_failed": "Falha no dump da collection [ {coll} ]: {message}",
	"views.dest_is_collection_error":
		'destino já tem uma COLLECTION "{name}" (não uma view) — pulando p/ não destruir dado',
	"ttl.duration.invalid_number": "Duração inválida: {input} (precisa ser > 0)",
	"ttl.duration.invalid_format":
		"Duração inválida: \"{input}\". Use <número><unidade>, ex.: 30d, 1h, 3mo. Unidades: s/sec/seconds, min/minutes, h/hours, d/days, w/weeks, mo/months, y/years. 'm' sozinho é proibido (ambíguo minuto/mês): use 'min' ou 'mo'.",
	"ttl.duration.invalid_value": 'Duração inválida: "{input}" (precisa ser > 0)',
	"ttl.resolve.field_derive_exclusive":
		'Collection "{name}": "field" e "deriveFromId" são mutuamente exclusivos',
	"ttl.resolve.no_field":
		'Collection "{name}" sem campo de TTL definido: informe "field" (campo Date existente) ou "deriveFromId: true"',
	"ttl.resolve.no_expire":
		'Collection "{name}" sem "expire"/"expireAfterSeconds" definido',
	"panel.bar.format":
		"{collection} ⟬{bar}⟭ {percentage}% | {value}/{total} | ↷ {skip} skip | ✎ {upd} upd | ⊕ {ins} ins | ⧖ {duration_formatted}",
	"status.header": "  SYNC · DUMP INICIAL",
	"status.footer":
		"  resumidas (sem dump, mantidas pelo watch): {resuming}  ·  dump concluído: {done}/{planned}  ·  em andamento: {active}  ·  total: {total}",
	"panel.title": "PULSAR · SINCRONIZAÇÃO INICIAL CONCLUÍDA",
	"panel.mode": "MODO: tempo real · replicando mudanças ao vivo",
	"panel.collections_ok": "Collections em dia ........ {ok}/{total}",
	"panel.resumed": "  ↳ retomadas (delta) ..... {resumed}",
	"panel.dumped": "  ↳ dump completo ......... {dumped}{dumpedLabel}",
	"panel.dumped_names": "  ({names})",
	"panel.failed": "  ↳ FALHARAM (re-dump) .... {count} ({names})",
	"panel.docs_dumped": "Docs copiados no dump ..... {docs}",
	"panel.duration": "Duração ................... {dur}",
	"panel.indexes":
		"Índices ... criados: {created} · já existiam: {skipped}{fLabel}",
	"panel.indexes_failed": " · falharam: {count} ({colls})",
	"panel.views":
		"Views ..... criadas: {created} · atualizadas: {updated} · iguais: {skipped}{fLabel}",
	"panel.views_failed": " · falharam: {count} ({names})",
	"watch.heartbeat.head": "──── PULSAR · WATCH ATIVO ──── uptime {uptime}",
	"watch.heartbeat.idle": "{head} · 0 eventos (origem quieta)",
	"watch.heartbeat.top": "   mais ativas: {top}{rest}",
	"watch.heartbeat.top_rest": "  (+{rest})",
	"watch.heartbeat.events":
		" eventos: {total}  (ins {insert} · upd {update} · rep {replace} · del {delete})",
	"load.report":
		"CARGA INICIAL CONCLUÍDA: {count} collections | início {start} | fim {end} | total {total}",
	"cli.title.fallback": "«« PULSAR »»",
	"progressbar.default_label": "Progresso",
	"yml.error.not_found": "Arquivo não encontrado no caminho: {path}",
	"yml.error.empty": "Arquivo YML está vazio ou malformado",
	"migrate.tools_missing":
		"Binário(s) não encontrado(s) no PATH: {missing}. O migrate precisa do mongodb-database-tools. Instale e tente de novo. Ubuntu: baixe o .deb em https://www.mongodb.com/try/download/database-tools (ex.: sudo apt install -y ./mongodb-database-tools-<codename>-x86_64-<versao>.deb). Confirme com: mongodump --version",
	"collections.filterfile_unreadable":
		"Não foi possível ler o filterFile: {filterFile}",
	"collections.none_to_watch":
		"Nenhuma collection para observar no arquivo: {ymlPath}",
	"conn.uri_empty": "Mongo URI not declared or is empty: uri={uri}",
	"conn.connecting": "Conectando ao MongoDB...",
	"conn.connected": "Conectado ao {source} MongoDB!",
	"conn.unreachable":
		"Não alcancei o MongoDB ({source}). Verifique: 1) seu IP está na Network Access (IP allowlist) do Atlas; 2) a saída TCP na 27017 não está bloqueada; 3) credenciais/URI. Detalhes em logs/error.log",
} as const;

export default dict;
