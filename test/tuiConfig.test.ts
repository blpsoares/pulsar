import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import {
	detectConfigs,
	detectConfigsWithMeta,
} from "../src/core/compose/detectConfigs";
import { buildConfig } from "../src/core/config/buildConfig";
import { emptyForm, validateForm } from "../src/core/config/formState";
import {
	mergeCollections,
	parseConfigObject,
} from "../src/core/config/loadConfig";
import { toYaml, validateConfig } from "../src/core/config/writeConfig";
import { formatBytes, formatCount } from "../src/core/inspect/collStats";
import { filterEntries, isInternalName } from "../src/core/inspect/inspectDb";
import { buildTransferPlan } from "../src/core/inspect/summary";
import { gradient } from "../src/tui/theme";

function syncForm() {
	const f = emptyForm("sync");
	f.source = { uri: "mongodb://src:27017", db: "prod" };
	f.destination = { uri: "mongodb://dst:27017", db: "replica" };
	f.collections = ["users", "orders"];
	return f;
}

describe("buildConfig", () => {
	test("gera um sync válido e enxuto (sem defaults ruidosos)", () => {
		const config = buildConfig(syncForm());
		expect(validateConfig("sync", config)).toEqual([]);

		const sync = (config.command as Record<string, Record<string, unknown>>)
			.sync;
		expect(sync.collections).toEqual(["users", "orders"]);
		// progress:true e verbose:false são default do pulsar — não vão pro arquivo
		expect(sync.logging).toBeUndefined();
		expect(sync.copyIndexes).toBeUndefined();
	});

	test("emite logging apenas quando difere do default", () => {
		const f = syncForm();
		f.logging = { verbose: true, progress: false };
		const sync = (
			buildConfig(f).command as Record<string, Record<string, unknown>>
		).sync;
		expect(sync.logging).toEqual({ verbose: true, progress: false });
	});

	test("copyViews aceita true e lista, e ignora lista vazia", () => {
		const f = syncForm();
		f.copyViews = true;
		expect(
			(buildConfig(f).command as Record<string, Record<string, unknown>>).sync
				.copyViews,
		).toBe(true);

		f.copyViews = ["regioes"];
		expect(
			(buildConfig(f).command as Record<string, Record<string, unknown>>).sync
				.copyViews,
		).toEqual(["regioes"]);

		f.copyViews = [];
		expect(
			(buildConfig(f).command as Record<string, Record<string, unknown>>).sync
				.copyViews,
		).toBeUndefined();
	});

	test("ttl não emite destino e valida contra o schema de ttl", () => {
		const f = emptyForm("ttl");
		f.source = { uri: "mongodb://src:27017", db: "replica" };
		f.collections = ["logs"];
		f.ttlDefaults = { deriveFromId: true, expire: "30d" };

		const config = buildConfig(f);
		expect(validateConfig("ttl", config)).toEqual([]);
		const ttl = (config.command as Record<string, Record<string, unknown>>).ttl;
		expect(ttl.destination).toBeUndefined();
		expect(ttl.defaults).toEqual({ deriveFromId: true, expire: "30d" });
	});

	test("preserva filtros de collection ao salvar por cima", () => {
		const preserved = new Map([
			["orders", { name: "orders", filter: { status: "active" } }],
		]);
		const sync = (
			buildConfig(syncForm(), preserved).command as Record<
				string,
				Record<string, unknown>
			>
		).sync;
		expect(sync.collections).toEqual([
			"users",
			{ name: "orders", filter: { status: "active" } },
		]);
	});
});

describe("round-trip yml", () => {
	test("build -> yaml -> parse devolve o mesmo form", () => {
		const original = syncForm();
		original.copyIndexes = true;
		original.performance = { parallel: 4, batchSize: 1000 };

		const text = toYaml(buildConfig(original));
		const loaded = parseConfigObject(yaml.load(text));

		expect(loaded).not.toBeNull();
		expect(loaded?.form.mode).toBe("sync");
		expect(loaded?.form.source).toEqual(original.source);
		expect(loaded?.form.destination).toEqual(original.destination);
		expect(loaded?.form.collections).toEqual(original.collections);
		expect(loaded?.form.copyIndexes).toBe(true);
		expect(loaded?.form.performance.parallel).toBe(4);
	});

	test("filtro sobrevive ao round-trip de edição", () => {
		const raw = {
			command: {
				sync: {
					source: { uri: "u", db: "a" },
					destination: { uri: "u2", db: "b" },
					collections: ["users", { name: "logs", filterFile: "./f.json" }],
				},
			},
		};
		const loaded = parseConfigObject(raw);
		expect(loaded?.form.collections).toEqual(["users", "logs"]);

		const merged = mergeCollections(
			loaded?.form.collections ?? [],
			loaded?.preservedEntries ?? new Map(),
		);
		expect(merged).toEqual(["users", { name: "logs", filterFile: "./f.json" }]);
	});

	test("yml que não é do pulsar é rejeitado", () => {
		expect(parseConfigObject({ services: {} })).toBeNull();
		expect(parseConfigObject(null)).toBeNull();
	});
});

describe("validateForm", () => {
	test("form vazio acusa os campos obrigatórios", () => {
		const errors = validateForm(emptyForm("sync")).map((e) => e.field);
		expect(errors).toContain("source.uri");
		expect(errors).toContain("destination.db");
		expect(errors).toContain("collections");
	});

	test("origem igual ao destino é bloqueado", () => {
		const f = syncForm();
		f.destination = { ...f.source };
		expect(validateForm(f).some((e) => /mesmo banco/.test(e.message))).toBe(
			true,
		);
	});

	test("ttl exige âncora de data e duração", () => {
		const f = emptyForm("ttl");
		f.source = { uri: "u", db: "d" };
		f.collections = ["logs"];
		const fields = validateForm(f).map((e) => e.field);
		expect(fields).toContain("ttl.field");
		expect(fields).toContain("ttl.expire");
	});

	test("field + deriveFromId juntos são mutuamente exclusivos", () => {
		const f = emptyForm("ttl");
		f.source = { uri: "u", db: "d" };
		f.collections = ["logs"];
		f.ttlDefaults = { field: "createdAt", deriveFromId: true, expire: "30d" };
		expect(
			validateForm(f).some((e) => /mutuamente exclusiv/.test(e.message)),
		).toBe(true);
	});

	test("form completo passa", () => {
		expect(validateForm(syncForm())).toEqual([]);
	});
});

describe("buildTransferPlan", () => {
	const estimates = [
		{
			name: "users",
			docs: 1000,
			storageSize: 2048,
			totalIndexSize: 512,
			indexCount: 3,
			exact: false,
		},
		{
			name: "orders",
			docs: 500,
			storageSize: 1024,
			totalIndexSize: 256,
			indexCount: 2,
			exact: false,
		},
		{
			name: "ignorada",
			docs: 9999,
			storageSize: 1,
			totalIndexSize: 1,
			indexCount: 1,
			exact: false,
		},
	];

	test("soma só o que está selecionado e marca como aproximado", () => {
		const plan = buildTransferPlan({
			mode: "sync",
			selected: ["users", "orders"],
			estimates,
		});
		expect(plan.docs).toBe(1500);
		expect(plan.dataSize).toBe(3072);
		expect(plan.approximate).toBe(true);
	});

	test("índices só contam no sync quando copyIndexes está ligado", () => {
		const indexes = [
			{ collection: "users", indexes: [], secondaryCount: 2 },
			{ collection: "orders", indexes: [], secondaryCount: 1 },
		];
		const base = {
			mode: "sync" as const,
			selected: ["users", "orders"],
			estimates,
			indexes,
		};

		expect(buildTransferPlan(base).indexes).toBe(0);
		expect(buildTransferPlan({ ...base, copyIndexes: true }).indexes).toBe(3);

		// Seleção fina: conta os índices marcados, e só os que existem mesmo na
		// origem — um nome digitado à mão que não bate não pode inflar o número.
		const comNomes = [
			{
				collection: "users",
				indexes: [
					{ name: "_id_", key: {}, unique: false, ttl: false },
					{ name: "email_1", key: { email: 1 }, unique: true, ttl: false },
					{ name: "criado_1", key: { criado: 1 }, unique: false, ttl: false },
				],
				secondaryCount: 2,
			},
		];
		expect(
			buildTransferPlan({
				...base,
				indexes: comNomes,
				copyIndexes: [{ collection: "users", indexes: ["email_1"] }],
			}).indexes,
		).toBe(1);
		expect(
			buildTransferPlan({
				...base,
				indexes: comNomes,
				copyIndexes: [
					{ collection: "users", indexes: ["email_1", "nao_existe"] },
				],
			}).indexes,
		).toBe(1);
		// Collection fora da seleção não conta, mesmo listada.
		expect(
			buildTransferPlan({
				...base,
				indexes: comNomes,
				copyIndexes: [{ collection: "fora", indexes: ["x_1"] }],
			}).indexes,
		).toBe(0);
	});

	test("migrate leva índices sempre (mongorestore) e nunca views", () => {
		const plan = buildTransferPlan({
			mode: "migrate",
			selected: ["users"],
			estimates,
			indexes: [{ collection: "users", indexes: [], secondaryCount: 4 }],
			sourceViews: [{ name: "v", kind: "view", viewOn: "users" }],
			copyViews: true,
		});
		expect(plan.indexes).toBe(4);
		expect(plan.views).toBe(0);
	});

	test("avisa quando a view aponta pra collection fora da seleção", () => {
		const plan = buildTransferPlan({
			mode: "sync",
			selected: ["users"],
			estimates,
			sourceViews: [
				{ name: "v_orders", kind: "view", viewOn: "orders" },
				{ name: "v_users", kind: "view", viewOn: "users" },
			],
			copyViews: true,
		});
		expect(plan.views).toBe(2);
		expect(plan.warnings.some((w) => w.includes("v_orders"))).toBe(true);
		expect(plan.warnings.some((w) => w.includes("v_users"))).toBe(false);
	});

	test("ttl não envia documentos e cria 1 índice por collection", () => {
		const plan = buildTransferPlan({
			mode: "ttl",
			selected: ["users", "orders"],
			estimates,
		});
		expect(plan.docs).toBe(0);
		expect(plan.indexes).toBe(2);
	});
});

describe("helpers de exibição", () => {
	test("filterEntries é case-insensitive e por substring", () => {
		const entries = [
			{ name: "orders" },
			{ name: "pre_Orders" },
			{ name: "users" },
		];
		expect(filterEntries(entries, "ord").map((e) => e.name)).toEqual([
			"orders",
			"pre_Orders",
		]);
		expect(filterEntries(entries, "  ").length).toBe(3);
	});

	test("nomes internos ficam fora da lista", () => {
		expect(isInternalName("system.views")).toBe(true);
		expect(isInternalName("__sync")).toBe(true);
		expect(isInternalName("users")).toBe(false);
	});

	test("formatação cabe em coluna estreita", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GB");
		expect(formatCount(999)).toBe("999");
		expect(formatCount(215_000_000)).toBe("215M");
	});
});

describe("gradiente da marca", () => {
	test("gera uma cor por caractere, do roxo da marca ao magenta", () => {
		const colors = gradient(6);
		expect(colors).toHaveLength(6);
		// começa exatamente no roxo do banner da CLI (utils/showCliTitle.ts)
		expect(colors[0]).toBe("#9b00ff");
		expect(colors.at(-1)).toBe("#ff5cf4");
		expect(colors.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
	});

	test("um caractere só não quebra a interpolação", () => {
		expect(gradient(1)).toEqual(["#9b00ff"]);
	});
});

describe("varredura recursiva de configs", () => {
	const root = mkdtempSync(join(tmpdir(), "pulsar-scan-"));

	beforeAll(() => {
		const write = (rel: string, body: string) => {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), body);
		};
		const sync = (db: string) =>
			`command:\n  sync:\n    source: { uri: u, db: a }\n    destination: { uri: u2, db: ${db} }\n`;

		write("raiz.yml", sync("r"));
		write("configs/prod.yml", sync("p"));
		write("infra/k8s/deep.yml", sync("d"));
		write("node_modules/pacote/config.yml", sync("nao"));
		write(".git/oculto.yml", sync("nao"));
		write("logs/ignorado.yml", sync("nao"));
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	test("sem recursive, enxerga só o diretório informado", () => {
		expect(detectConfigs(root).map((c) => c.file)).toEqual(["raiz.yml"]);
	});

	test("com recursive, acha as configs em subpastas", () => {
		const files = detectConfigs(root, { recursive: true }).map((c) => c.file);
		expect(files).toContain("raiz.yml");
		expect(files).toContain(join("configs", "prod.yml"));
		expect(files).toContain(join("infra", "k8s", "deep.yml"));
	});

	test("pula node_modules, pastas ocultas e logs", () => {
		const files = detectConfigs(root, { recursive: true }).map((c) => c.file);
		expect(files.some((f) => f.includes("node_modules"))).toBe(false);
		expect(files.some((f) => f.includes(".git"))).toBe(false);
		expect(files.some((f) => f.includes("logs"))).toBe(false);
	});

	test("caminho devolvido é relativo ao diretório da varredura", () => {
		const files = detectConfigs(root, { recursive: true }).map((c) => c.file);
		expect(files.every((f) => !f.startsWith("/"))).toBe(true);
	});

	test("orçamento de tempo zerado corta a varredura e avisa", () => {
		const result = detectConfigsWithMeta(root, {
			recursive: true,
			budgetMs: 0,
		});
		expect(result.truncated).toBe(true);
	});

	test("teto de arquivos é respeitado", () => {
		const result = detectConfigsWithMeta(root, {
			recursive: true,
			maxFiles: 1,
		});
		expect(result.configs.length).toBeLessThanOrEqual(1);
		expect(result.truncated).toBe(true);
	});
});

/**
 * `copyIndexes` como LISTA — a escolha índice a índice do passo "índices".
 * A forma de objeto ({collection, indexes}) existe porque nome de collection e
 * nome de índice aceitam ponto: "vendas.2024.status_1" seria indecifrável.
 */
describe("copyIndexes por índice", () => {
	function syncFormWithIndexes() {
		const f = syncForm();
		f.copyIndexes = [
			{ collection: "pedidos", indexes: ["cliente_1", "data_-1_status_1"] },
		];
		return f;
	}

	test("grava a lista escolhida no yml", () => {
		const sync = (
			buildConfig(syncFormWithIndexes()).command as Record<
				string,
				Record<string, unknown>
			>
		).sync;
		expect(sync.copyIndexes).toEqual([
			{ collection: "pedidos", indexes: ["cliente_1", "data_-1_status_1"] },
		]);
	});

	test("collection sem nenhum índice marcado não vai para o arquivo", () => {
		const f = syncForm();
		f.copyIndexes = [
			{ collection: "pedidos", indexes: ["cliente_1"] },
			{ collection: "clientes", indexes: [] },
		];
		const sync = (
			buildConfig(f).command as Record<string, Record<string, unknown>>
		).sync;
		expect(sync.copyIndexes).toEqual([
			{ collection: "pedidos", indexes: ["cliente_1"] },
		]);
	});

	test("lista inteiramente vazia não gera a chave", () => {
		const f = syncForm();
		f.copyIndexes = [];
		const sync = (
			buildConfig(f).command as Record<string, Record<string, unknown>>
		).sync;
		expect(sync.copyIndexes).toBeUndefined();
	});

	test("sobrevive ao round-trip", () => {
		const original = syncFormWithIndexes();
		const loaded = parseConfigObject(yaml.load(toYaml(buildConfig(original))));
		expect(loaded?.form.copyIndexes).toEqual(original.copyIndexes);
	});

	test("true continua valendo (todos os índices)", () => {
		const f = syncForm();
		f.copyIndexes = true;
		const loaded = parseConfigObject(yaml.load(toYaml(buildConfig(f))));
		expect(loaded?.form.copyIndexes).toBe(true);
	});
});
