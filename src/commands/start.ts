import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import chalk from "chalk";
import { detectConfigs } from "../core/compose/detectConfigs";
import type { ResourceRec } from "../core/compose/recommend";
import { buildConfig } from "../core/config/buildConfig";
import {
	emptyForm,
	type FormState,
	validateForm,
} from "../core/config/formState";
import { suggestFileName, writeConfigFile } from "../core/config/writeConfig";
import type { TuiMode } from "../core/inspect/summary";
import { argsFor, pulsarCommand } from "../core/run/pulsarCommand";
import {
	type BackendAvailability,
	detectBackends,
	preferredBackend,
} from "../core/service/detect";
import {
	buildPlan,
	installService,
	recommendedResources,
} from "../core/service/manager";
import type { Backend, ServiceSpec } from "../core/service/types";

/**
 * `pulsar start` — o caminho guiado, na CLI.
 *
 * Existe porque as duas portas de entrada anteriores eram ruins para quem só
 * quer subir uma réplica: a TUI é uma interface inteira para aprender antes de
 * conseguir a primeira coisa, e `pulsar sync arquivo.yml` exige que o arquivo
 * já exista e que se saiba que "background" é assunto de outro comando. Aqui a
 * pergunta é a que a pessoa tem na cabeça — o que rodar, aqui ou solto, e com
 * quem — e cada resposta já é o passo seguinte.
 *
 * Sem ink de propósito: é um fluxo linear de perguntas, não uma tela. Usa o
 * `prompt()` global do Bun, o mesmo do `pulsar compose up`.
 */

// ------------------------------------------------------------------ prompts

/** Pergunta com padrão; Enter aceita o padrão. Cancelar (ctrl+c/EOF) encerra. */
function ask(question: string, fallback?: string): string {
	const suffix = fallback ? chalk.gray(` [${fallback}]`) : "";
	const answer = prompt(chalk.cyan(question) + suffix);
	// `null` = EOF (ctrl+d) ou ctrl+c: encerrar é a leitura certa, e não
	// prosseguir com string vazia como se a pessoa tivesse respondido.
	if (answer === null) {
		console.log(chalk.gray("\ncancelado."));
		process.exit(0);
	}
	const trimmed = answer.trim();
	return trimmed || fallback || "";
}

function askRequired(question: string, fallback?: string): string {
	for (;;) {
		const value = ask(question, fallback);
		if (value) return value;
		console.log(chalk.yellow("  precisa de um valor."));
	}
}

function askYesNo(question: string, defaultYes: boolean): boolean {
	const value = ask(`${question} (s/n)`, defaultYes ? "s" : "n").toLowerCase();
	return value.startsWith("s") || value.startsWith("y");
}

/**
 * Menu numerado. Devolve o índice escolhido.
 *
 * Opções indisponíveis continuam VISÍVEIS, com o motivo ao lado, em vez de
 * sumirem: uma lista onde o systemd simplesmente não aparece faz o usuário
 * procurar o que ele fez de errado. Ver o item riscado e o porquê responde a
 * pergunta antes dela ser feita.
 */
function askChoice(
	title: string,
	options: { label: string; hint?: string; disabled?: string }[],
	defaultIndex = 0,
): number {
	console.log(`\n${chalk.bold(title)}`);
	options.forEach((o, i) => {
		const n = chalk.magenta(String(i + 1).padStart(2));
		if (o.disabled) {
			console.log(
				`${n}  ${chalk.gray.strikethrough(o.label)}  ${chalk.gray(o.disabled)}`,
			);
			return;
		}
		console.log(`${n}  ${o.label}${o.hint ? chalk.gray(`  ${o.hint}`) : ""}`);
	});

	for (;;) {
		const raw = ask("escolha o número", String(defaultIndex + 1));
		const i = Number(raw) - 1;
		if (!Number.isInteger(i) || i < 0 || i >= options.length) {
			console.log(chalk.yellow("  número fora da lista."));
			continue;
		}
		const chosen = options[i];
		if (chosen?.disabled) {
			console.log(chalk.yellow(`  indisponível: ${chosen.disabled}`));
			continue;
		}
		return i;
	}
}

// -------------------------------------------------------------- criar config

/**
 * Formulário mínimo de config. Deliberadamente mínimo: cobre origem, destino e
 * collections, que é o suficiente para um sync rodar. O ajuste fino (filtros
 * por collection, copyIndexes, performance) continua sendo a TUI ou o yml na
 * mão — repetir aqui o wizard inteiro só produziria duas implementações do
 * mesmo formulário para manter em sincronia.
 */
function createConfig(dir: string): string | null {
	const modes: TuiMode[] = ["sync", "migrate", "ttl"];
	const modeIndex = askChoice("o que essa config faz?", [
		{ label: "sync", hint: "réplica contínua (change stream, 24/7)" },
		{ label: "migrate", hint: "cópia pontual (mongodump/restore)" },
		{ label: "ttl", hint: "índices TTL em massa (não copia dados)" },
	]);
	const mode = modes[modeIndex] as TuiMode;

	const form: FormState = emptyForm(mode);

	console.log(chalk.bold("\norigem"));
	form.source.uri = askRequired("  URI do Mongo de origem");
	form.source.db = askRequired("  banco de origem");

	if (mode !== "ttl") {
		console.log(chalk.bold("\ndestino"));
		form.destination.uri = askRequired(
			"  URI do Mongo de destino",
			form.source.uri,
		);
		form.destination.db = askRequired("  banco de destino");
	}

	console.log(chalk.bold("\ncollections"));
	console.log(
		chalk.gray(
			"  separadas por vírgula. O yml lista sempre os nomes explicitamente.",
		),
	);
	const nomes = askRequired("  collections")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	form.collections = nomes;

	if (mode === "ttl") {
		console.log(chalk.bold("\nTTL"));
		form.ttlDefaults.expire = askRequired(
			"  expirar depois de (ex.: 30d, 12h, 3mo)",
			"30d",
		);
		// Derivar do _id é sempre explícito no pulsar — nada implícito.
		if (askYesNo("  derivar a data do _id (ObjectId)?", true))
			form.ttlDefaults.deriveFromId = true;
		else form.ttlDefaults.field = askRequired("  campo de data (BSON Date)");
	}

	const problemas = validateForm(form);
	if (problemas.length > 0) {
		console.log(chalk.red("\nfaltou preencher:"));
		for (const p of problemas) console.log(chalk.red(`  · ${p.message}`));
		return null;
	}

	const sugerido = suggestFileName(
		mode,
		mode === "ttl" ? form.source.db : form.destination.db,
		dir,
	);
	const nome = ask("\nsalvar como", sugerido);
	const alvo = resolve(dir, nome);

	if (existsSync(alvo) && !askYesNo(`${nome} já existe. sobrescrever?`, false))
		return null;

	const result = writeConfigFile(alvo, mode, buildConfig(form));
	if (!result.ok) {
		console.log(chalk.red("\nnão consegui gravar:"));
		for (const e of result.errors) console.log(chalk.red(`  · ${e}`));
		return null;
	}

	console.log(chalk.green(`\n✔ ${nome} criado.`));
	return nome;
}

// ------------------------------------------------------------------- escolha

function chooseConfig(dir: string): string | null {
	const configs = detectConfigs(dir, { recursive: true }).filter(
		(c) => c.kind !== "desconhecido",
	);

	if (configs.length === 0) {
		console.log(
			chalk.yellow("nenhuma config do pulsar encontrada nesta pasta."),
		);
		return askYesNo("criar uma agora?", true) ? createConfig(dir) : null;
	}

	const index = askChoice("qual config?", [
		...configs.map((c) => ({
			label: c.file,
			hint: `${c.kind}${c.destDb ? ` → ${c.destDb}` : ""}`,
		})),
		{ label: chalk.italic("criar uma nova config…") },
	]);

	if (index === configs.length) return createConfig(dir);
	return configs[index]?.file ?? null;
}

// -------------------------------------------------------------- background

function chooseBackend(availability: BackendAvailability[]): Backend | null {
	const preferido = preferredBackend(availability);
	const options = availability.map((a) => ({
		label: a.backend,
		hint: a.backend === preferido ? "recomendado aqui" : undefined,
		// O motivo vem do detect, que já sabe distinguir "não existe nesta
		// plataforma" de "existe mas não funciona nesta sessão".
		disabled: a.available ? undefined : (a.reason ?? "indisponível"),
	}));

	if (!options.some((o) => !o.disabled)) {
		console.log(chalk.red("\nnenhum supervisor disponível nesta máquina:"));
		for (const o of options)
			console.log(chalk.red(`  · ${o.label}: ${o.disabled}`));
		return null;
	}

	const defaultIndex = Math.max(
		0,
		availability.findIndex((a) => a.backend === preferido),
	);
	const i = askChoice("qual supervisor?", options, defaultIndex);
	return availability[i]?.backend ?? null;
}

/**
 * Cerca de RAM/CPU do container: mostra o recomendado e deixa ajustar.
 *
 * O recomendado NÃO é "a máquina inteira": é o orçamento da VM (~65% da RAM,
 * ~1 núcleo livre) MENOS o que as instâncias de pulsar já existentes
 * comprometeram — por isso ele encolhe a cada instância nova, e por isso a
 * soma de todas continua cabendo. Isso precisa estar à vista: o teto de
 * memória é o que decide se um OOM mata só o container ou derruba a VM, e
 * antes o pulsar escolhia esse número sozinho, sem dizer a ninguém.
 */
function askResources(): ResourceRec {
	const rec = recommendedResources();

	console.log(
		`\n${chalk.bold("recursos do container")} ${chalk.gray("(orçamento da máquina − já comprometido → recomendado)")}`,
	);
	console.log(
		`    mem_limit/memswap ${chalk.green(`${rec.memLimitMiB}m`)} · ` +
			`mem_reservation ${chalk.green(`${rec.memReservMiB}m`)} · ` +
			`cpus ${chalk.green(String(rec.cpus))}`,
	);
	console.log(
		chalk.gray(
			"    mem_limit é TETO DURO: ao estourar, o kernel mata só o container (a VM sobrevive) e o restart sobe de novo.",
		),
	);

	if (askYesNo("usar os valores recomendados?", true)) return rec;

	return {
		memLimitMiB: numOr(
			ask("  mem_limit (MiB)", String(rec.memLimitMiB)),
			rec.memLimitMiB,
		),
		memReservMiB: numOr(
			ask("  mem_reservation (MiB)", String(rec.memReservMiB)),
			rec.memReservMiB,
		),
		cpus: numOr(
			ask("  cpus (núcleos, aceita fração)", String(rec.cpus)),
			rec.cpus,
		),
	};
}

/** Number() seguro: devolve o fallback se vazio/NaN/não-positivo. */
function numOr(input: string, fallback: number): number {
	const n = Number(input.trim());
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function runInBackground(dir: string, file: string): Promise<void> {
	const path = resolve(dir, file);
	const availability = await detectBackends(dir);
	const backend = chooseBackend(availability);
	if (!backend) process.exit(1);

	const detected = detectConfigs(dir, { recursive: true }).find(
		(c) => c.file === file,
	);
	const mode = (detected?.kind ?? "sync") as TuiMode;

	const spec: ServiceSpec = {
		name: basename(file).replace(/\.ya?ml$/i, ""),
		mode,
		configPath: path,
		workingDir: dir,
		autostart: askYesNo("\nsubir junto com a máquina (boot)?", true),
	};

	// Só o docker tem cerca de recursos (cgroups). Perguntar sobre memória num
	// backend que não a limita seria pedir um número que não vai a lugar nenhum.
	const resources = backend === "docker" ? askResources() : undefined;

	const plan = buildPlan(backend, spec, resources);
	if ("error" in plan) {
		console.log(chalk.red(`\n${plan.error}`));
		process.exit(1);
	}

	// O plano é mostrado ANTES de executar: instalar serviço escreve arquivo em
	// ~/.config e liga coisa no boot — nada disso deve acontecer às cegas.
	console.log(`\n${chalk.bold(`plano · ${backend}`)}`);
	if (plan.resources)
		console.log(
			chalk.gray(
				`  recursos  mem_limit ${plan.resources.memLimitMiB}m · mem_reservation ${plan.resources.memReservMiB}m · cpus ${plan.resources.cpus}`,
			),
		);
	for (const f of plan.files) console.log(chalk.gray(`  arquivo  ${f.path}`));
	for (const s of plan.steps)
		console.log(`  ${chalk.magenta("$")} ${s.cmd} ${s.args.join(" ")}`);
	for (const n of plan.notes) console.log(chalk.gray(`  · ${n}`));
	for (const m of plan.manualSteps)
		console.log(
			chalk.yellow(
				`  você roda à mão: ${m.cmd} ${m.args.join(" ")}  (${m.why})`,
			),
		);

	if (!askYesNo("\nexecutar?", true)) {
		console.log(chalk.gray("cancelado."));
		return;
	}

	const result = await installService(plan, spec);
	for (const r of result.results)
		console.log(
			`${r.ok ? chalk.green("✔") : chalk.red("✖")} ${r.step.cmd} ${r.step.args.join(" ")}`,
		);

	if (result.ok) {
		console.log(chalk.green(`\n✔ ${plan.serviceName} no ar.`));
		console.log(
			chalk.gray("  logs:  pulsar tui  → escolha o serviço e tecle `l`"),
		);
		return;
	}

	// A saída COMPLETA do passo que falhou. Resumir aqui reproduziria o defeito
	// que a tela de background tinha: "parou num passo obrigatório" sem dizer
	// por quê, deixando o usuário sem nada para investigar.
	console.log(chalk.red(`\n✖ ${result.error ?? "falhou"}`));
	const falho = result.results.find((r) => !r.ok && r.raw);
	if (falho?.raw) {
		console.log(
			chalk.gray(`\n$ ${falho.step.cmd} ${falho.step.args.join(" ")}`),
		);
		console.log(falho.raw);
	}
	process.exit(1);
}

// -------------------------------------------------------------- primeiro plano

async function runInForeground(dir: string, file: string): Promise<void> {
	const detected = detectConfigs(dir, { recursive: true }).find(
		(c) => c.file === file,
	);
	const mode = (detected?.kind ?? "sync") as TuiMode;
	const { cmd, args } = pulsarCommand(argsFor(mode, resolve(dir, file), []));

	console.log(chalk.gray(`\n$ ${cmd} ${args.join(" ")}\n`));

	// Processo filho (e não import direto do comando) para que ctrl+c chegue
	// nele do jeito normal: o sync trata SIGINT gravando o resume token antes de
	// sair, e é esse caminho que já é testado.
	const proc = Bun.spawn([cmd, ...args], {
		cwd: dir,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(await proc.exited);
}

// ---------------------------------------------------------------- entrypoint

export async function startCommand(dir: string): Promise<void> {
	const file = chooseConfig(dir);
	if (!file) {
		console.log(chalk.gray("nada a fazer."));
		return;
	}

	const onde = askChoice("como rodar?", [
		{
			label: "aqui, no terminal",
			hint: "saída ao vivo; ctrl+c encerra com shutdown gracioso",
		},
		{
			label: "em background",
			hint: "instala como serviço e volta sozinho no boot",
		},
	]);

	if (onde === 0) await runInForeground(dir, file);
	else await runInBackground(dir, file);
}
