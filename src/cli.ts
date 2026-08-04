#! /usr/bin/env bun

import { Command } from "commander";
import { composeUp } from "./commands/compose";
import migrateCollections from "./commands/migrate";
import { syncCollections } from "./commands/sync";
import { ttlCommand } from "./commands/ttl";
import { verifyCommand } from "./commands/verify";
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

/**
 * `pulsar` sozinho é CLI, não TUI.
 *
 * Abrir a interface de tela cheia sem ninguém pedir sequestra o terminal de
 * quem só queria ver os comandos disponíveis — e num script ou container, onde
 * não há TTY, o programa morria com um erro sobre TTY em vez de mostrar a
 * ajuda. Agora `pulsar` lista os comandos, `pulsar tui` abre a interface e
 * `pulsar start` é o caminho guiado.
 *
 * O título em ASCII art é pulado no caminho da TUI: o ink toma conta da tela
 * inteira e o banner só empurraria o layout para fora da janela.
 */
const wantsTui = process.argv[2] === "tui";

if (!wantsTui) await showTitle();

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
	.command("verify <file>")
	.description(
		"confere se o destino REALMENTE tem o que a origem tem. O sync se diz 'em dia' pelo carimbo no __sync, que é bookkeeping — este comando olha o dado. Sai com código 1 se divergir.",
	)
	.option("-a --all", "confere todas as collections da origem")
	.option(
		"--collections <list>",
		"confere só estas, separadas por vírgula, ex.: pedidos,usuarios",
	)
	.option(
		"-d --deep",
		"compara _id a _id (exato, diz QUAIS docs faltam). Sem isso, só compara totais.",
	)
	.option(
		"-r --reconcile",
		"recopia da origem os docs faltantes encontrados (implica --deep).",
	)
	.option("-p --parallel <number>", "collections em paralelo. Padrão: 4.")
	.option("-b --batch <number>", "docs por rodada de comparação. Padrão: 2000.")
	.option("--json", "saída em JSON (para cron/CI)")
	.action(verifyCommand);

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
	.option(
		"-p --parallel <number>",
		"quantas collections recebem TTL em paralelo. Padrão: 4.",
	)
	// O commander espera `void | Promise<void>`: devolver o array de resultados
	// do ttlCommand tipava a action errado (e ninguém consome esse retorno aqui).
	.action(async (file, opts) => {
		await ttlCommand(file, {
			uri: opts.uri,
			db: opts.db,
			collections: opts.collections,
			all: opts.all,
			field: opts.field,
			deriveFromId: opts.deriveFromId,
			expire: opts.expire,
			parallel: opts.parallel,
		});
	});

const compose = program
	.command("compose")
	.description(
		"gerencia instâncias do pulsar-sync com cerca de recursos (cgroups)",
	);
compose
	.command("up")
	.description(
		"cria interativamente uma nova instância pulsar-sync ao lado das existentes, com recursos recomendados pelo uso atual da máquina",
	)
	.action(composeUp);

program
	.command("tui")
	.description(
		"abre a interface de terminal: cria configs, dispara os modos, instala em background e lê logs",
	)
	.action(async () => {
		const { startTui } = await import("./tui/index");
		await startTui(process.cwd());
	});

program
	.command("start")
	.description(
		"caminho guiado: escolhe a config (ou cria uma), pergunta se roda aqui ou em background e qual supervisor usar",
	)
	.action(async () => {
		const { startCommand } = await import("./commands/start");
		await startCommand(process.cwd());
	});

if (wantsTui) {
	// Import dinâmico: quem roda `pulsar sync` num container não paga o custo de
	// carregar react/ink.
	const { startTui } = await import("./tui/index");
	await startTui(process.cwd());
} else if (process.argv.length <= 2) {
	// Sem subcomando: a ajuda é a resposta certa — e ela já anuncia `tui` e
	// `start` para quem quer o caminho visual ou o guiado.
	program.outputHelp();
} else {
	program.parse(process.argv);
}
