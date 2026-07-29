import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import yaml from "js-yaml";

export type ConfigKind = "sync" | "migrate" | "ttl" | "desconhecido";

export type DetectedConfig = {
	file: string; // caminho relativo ao dir de busca
	kind: ConfigKind;
	sourceDb?: string;
	destDb?: string;
};

/**
 * Classifica um yml já parseado pela chave de topo do pulsar
 * (command.sync / command.migrate / command.ttl). Função pura.
 */
export function classifyConfig(parsed: unknown): Omit<DetectedConfig, "file"> {
	const cmd = (parsed as { command?: Record<string, unknown> })?.command;
	if (!cmd || typeof cmd !== "object") return { kind: "desconhecido" };

	if ("sync" in cmd) {
		const s = cmd.sync as {
			source?: { db?: string };
			destination?: { db?: string };
		};
		return {
			kind: "sync",
			sourceDb: s?.source?.db,
			destDb: s?.destination?.db,
		};
	}
	if ("migrate" in cmd) {
		const m = cmd.migrate as {
			source?: { db?: string };
			destination?: { db?: string };
		};
		return {
			kind: "migrate",
			sourceDb: m?.source?.db,
			destDb: m?.destination?.db,
		};
	}
	if ("ttl" in cmd) {
		const t = cmd.ttl as { source?: { db?: string } };
		return { kind: "ttl", sourceDb: t?.source?.db };
	}
	return { kind: "desconhecido" };
}

/**
 * Varre `dir` (não-recursivo) por *.yml/*.yaml, parseia leve e classifica cada
 * um. Arquivos que não parseiam são ignorados. Útil pra sugerir configs no
 * `pulsar compose up`.
 */
export type DetectOptions = {
	/** varrer subpastas a partir de `dir` */
	recursive?: boolean;
	/** profundidade máxima na varredura recursiva */
	maxDepth?: number;
	/** teto de arquivos yml analisados — para a varredura não virar um `find /` */
	maxFiles?: number;
	/** teto de diretórios visitados */
	maxDirs?: number;
	/** teto de tempo, em ms */
	budgetMs?: number;
};

export type DetectResult = {
	configs: DetectedConfig[];
	/** true quando algum limite cortou a varredura antes do fim */
	truncated: boolean;
	dirsVisited: number;
};

/**
 * Pastas que nunca contêm config do pulsar e podem ter DEZENAS DE MILHARES de
 * arquivos. Sem essa lista, abrir a TUI dentro de um projeto Node varreria o
 * `node_modules` inteiro antes de desenhar a primeira tela.
 */
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	"target",
	"tmp",
	"temp",
	"temp-dump",
	"logs",
	"__pycache__",
	".venv",
	"venv",
]);

/** yml de config do pulsar é pequeno; arquivo grande é outra coisa (dump, fixture). */
const MAX_YML_BYTES = 512 * 1024;

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_FILES = 400;
/**
 * Tetos de diretórios e de TEMPO. Só limitar profundidade e arquivos não basta:
 * medido numa HOME real, a varredura levou 1,3s (e a partir de `/` não
 * terminava) porque o custo está em percorrer dezenas de milhares de pastas,
 * não em ler os poucos ymls. Com o orçamento de tempo, abrir a TUI custa no
 * máximo isto, em qualquer lugar do sistema de arquivos.
 */
const DEFAULT_MAX_DIRS = 4000;
const DEFAULT_BUDGET_MS = 400;

/**
 * Varre `dir` por *.yml/*.yaml, parseia leve e classifica cada um.
 *
 * Por padrão olha só o diretório informado — é o que o `pulsar compose up`
 * espera, já que ele gera compose com caminhos relativos ao projeto.
 *
 * Com `recursive`, desce nas subpastas: a TUI usa esse modo para achar as
 * configs a partir de onde o usuário está, sem obrigá-lo a `cd` até a pasta
 * certa. A varredura é limitada de propósito (profundidade, lista de pastas
 * ignoradas, teto de arquivos e tamanho): uma TUI que congela por 20s ao abrir
 * numa home cheia seria pior do que não varrer.
 *
 * Symlinks de diretório não são seguidos — é o que evita laço infinito.
 */
export function detectConfigs(
	dir: string,
	options: DetectOptions = {},
): DetectedConfig[] {
	return detectConfigsWithMeta(dir, options).configs;
}

/**
 * Mesma varredura, dizendo se ela foi cortada por algum limite — a TUI usa isso
 * para avisar "achei N até aqui", em vez de deixar o usuário concluir que a
 * config dele não existe.
 */
export function detectConfigsWithMeta(
	dir: string,
	options: DetectOptions = {},
): DetectResult {
	const {
		recursive = false,
		maxDepth = DEFAULT_MAX_DEPTH,
		maxFiles = DEFAULT_MAX_FILES,
		maxDirs = DEFAULT_MAX_DIRS,
		budgetMs = DEFAULT_BUDGET_MS,
	} = options;

	const out: DetectedConfig[] = [];
	const deadline = Date.now() + budgetMs;
	let analysed = 0;
	let dirsVisited = 0;
	let truncated = false;

	const exhausted = (): boolean => {
		// `>=` e não `>`: um orçamento de 0ms significa "não há tempo para varrer",
		// e com `>` isso ainda varreria tudo que coubesse no milissegundo atual.
		if (
			analysed >= maxFiles ||
			dirsVisited >= maxDirs ||
			Date.now() >= deadline
		) {
			truncated = true;
			return true;
		}
		return false;
	};

	const walk = (current: string, depth: number): void => {
		if (exhausted()) return;
		dirsVisited++;

		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			// pasta sem permissão de leitura: ignora e segue
			return;
		}

		const subdirs: string[] = [];

		for (const entry of entries) {
			if (exhausted()) return;

			if (entry.isDirectory()) {
				if (!recursive || depth >= maxDepth) continue;
				if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
				subdirs.push(join(current, entry.name));
				continue;
			}

			if (!entry.isFile()) continue; // symlink de arquivo entra aqui: ignorado
			if (!/\.ya?ml$/i.test(entry.name)) continue;

			const full = join(current, entry.name);
			try {
				if (statSync(full).size > MAX_YML_BYTES) continue;
				analysed++;
				const parsed = yaml.load(readFileSync(full, "utf8"));
				out.push({
					file: relative(dir, full) || entry.name,
					...classifyConfig(parsed),
				});
			} catch {
				// arquivo ilegível/malformado -> ignora
			}
		}

		// Largura antes de profundidade: as configs mais próximas do diretório
		// atual aparecem primeiro, que é onde o usuário provavelmente está.
		for (const sub of subdirs) walk(sub, depth + 1);
	};

	walk(dir, 0);
	return { configs: out, truncated, dirsVisited };
}
