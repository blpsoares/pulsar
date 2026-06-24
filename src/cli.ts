#! /usr/bin/env bun

import { Command } from "commander";
import migrateCollections from "./commands/migrate";
import { syncCollections } from "./commands/sync";
import { ttlCommand } from "./commands/ttl";
import { logger } from "./utils/customLog";
import { showTitle } from "./utils/showCliTitle";

// Rede de segurança: um erro não tratado (ex.: blip de rede num handler async)
// não deve derrubar o daemon de sync. Logamos e seguimos rodando.
process.on("unhandledRejection", (reason) => {
	const message =
		reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
	logger.error(`unhandledRejection ${message}`);
	console.error("[ ERROR ] unhandledRejection:", message);
});
process.on("uncaughtException", (err) => {
	logger.error(`uncaughtException ${err.stack ?? err.message}`);
	console.error("[ ERROR ] uncaughtException:", err.message);
});

await showTitle();

const program = new Command();

program.version("1.0.0").description("Mongo pulsar cli to sync data");

program
	.command("migrate <file>")
	.option(
		"-p --parallel <number>",
		"send a number to export collections in parallel, example: -p 2 or --parallel 2.\nBy default this value is 2.",
	)
	.option(
		"-r --maxRetries <number>",
		"send a number to retry failed collections (exported and restored), example: -r 5 or --maxRetries 5.\nBy default this value is 3.",
	)
	.option("-a --all", "watch all collections")
	.action(migrateCollections);

program
	.command("sync <file>")
	.option("-a --all", "watch all collections")
	.option(
		"-p --parallel <number>",
		"quantas collections fazem o dump inicial em paralelo. Padrão: 3.",
	)
	.option(
		"-b --batch <number>",
		"tamanho do lote (find $in + bulkWrite) no dump inicial. Padrão: 500.",
	)
	.option(
		"-v --verbose",
		"log each watch event (insert, update, delete, replace)",
	)
	.option(
		"-f --full",
		"força o dump completo de todas as collections, ignorando os carimbos de conclusão (reconciliação total).",
	)
	.action(syncCollections);

program
	.command("ttl [file]")
	.description(
		"cria índices TTL em massa. Com [file] usa yml granular; sem arquivo, usa as flags abaixo (config uniforme).",
	)
	.option("--uri <uri>", "URI do Mongo (modo CLI)")
	.option("--db <db>", "banco alvo (modo CLI)")
	.option(
		"--collections <list>",
		"collections separadas por vírgula, ex.: orders,logs,posts",
	)
	.option("-a --all", "aplica em todas as collections do banco")
	.option("--field <field>", "campo Date existente como base do TTL")
	.option(
		"--derive-from-id",
		"materializa _created a partir do _id (explícito)",
	)
	.option("--expire <dur>", "duração: 30d, 1h, 3mo, 90d... (mês=30d, ano=365d)")
	.action((file, opts) =>
		ttlCommand(file, {
			uri: opts.uri,
			db: opts.db,
			collections: opts.collections,
			all: opts.all,
			field: opts.field,
			deriveFromId: opts.deriveFromId,
			expire: opts.expire,
		}),
	);

program.parse(process.argv);
