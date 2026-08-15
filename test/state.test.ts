import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chalk } from "chalk";
import {
	adoptFromDocker,
	adoptFromSystemd,
	parseExecStart,
} from "../src/core/state/adopt";
import {
	CREATED_BY_TUI,
	listRecords,
	readRecord,
	registryDir,
	removeRecord,
	type ServiceRecord,
	writeRecord,
} from "../src/core/state/registry";
import {
	beginRun,
	describeError,
	finishRun,
	isAlreadyHandled,
	serviceNameFromEnv,
} from "../src/core/state/runRecord";

function home() {
	return mkdtempSync(join(tmpdir(), "pulsar-home-"));
}

const base: ServiceRecord = {
	name: "pulsar-ads",
	mode: "sync",
	config: "/srv/pulsar/ads.yml",
	workingDir: "/srv/pulsar",
	backend: "systemd",
	boot: true,
	createdBy: CREATED_BY_TUI,
	lastRun: null,
};

describe("registry", () => {
	test("grava e lê de volta", () => {
		const h = home();
		writeRecord(base, h);
		expect(readRecord("pulsar-ads", h)).toEqual(base);
	});

	test("serviço inexistente devolve null, não joga", () => {
		expect(readRecord("pulsar-nao-existe", home())).toBeNull();
	});

	test("lista todos, em ordem de nome", () => {
		const h = home();
		writeRecord({ ...base, name: "pulsar-z" }, h);
		writeRecord({ ...base, name: "pulsar-a" }, h);
		expect(listRecords(h).map((r) => r.name)).toEqual(["pulsar-a", "pulsar-z"]);
	});

	test("json corrompido é ignorado sem derrubar a lista", () => {
		// A lista da tela não pode sumir por causa de um arquivo estragado.
		const h = home();
		writeRecord(base, h);
		mkdirSync(registryDir(h), { recursive: true });
		writeFileSync(join(registryDir(h), "quebrado.json"), "{ isto não é json");
		expect(listRecords(h).map((r) => r.name)).toEqual(["pulsar-ads"]);
	});

	test("json válido mas fora do schema é ignorado", () => {
		const h = home();
		mkdirSync(registryDir(h), { recursive: true });
		writeFileSync(join(registryDir(h), "x.json"), JSON.stringify({ nome: 1 }));
		expect(listRecords(h)).toEqual([]);
	});

	test("remover apaga o arquivo", () => {
		const h = home();
		writeRecord(base, h);
		removeRecord("pulsar-ads", h);
		expect(readRecord("pulsar-ads", h)).toBeNull();
	});

	test("não deixa arquivo temporário para trás", () => {
		const h = home();
		writeRecord(base, h);
		expect(readdirSync(registryDir(h))).toEqual(["pulsar-ads.json"]);
	});
});

describe("runRecord", () => {
	test("beginRun marca running e limpa o resultado anterior", () => {
		const h = home();
		writeRecord(base, h);
		beginRun("pulsar-ads", h);

		const run = readRecord("pulsar-ads", h)?.lastRun;
		expect(run?.status).toBe("running");
		expect(run?.endedAt).toBeNull();
		expect(run?.startedAt).toBeTruthy();
	});

	test("finishRun grava stats e mantém o startedAt do begin", () => {
		const h = home();
		writeRecord(base, h);
		beginRun("pulsar-ads", h);
		const startedAt = readRecord("pulsar-ads", h)?.lastRun?.startedAt;

		finishRun(
			"pulsar-ads",
			{
				status: "ok",
				exitCode: 0,
				stats: { collections: 49, inserted: 1214882 },
			},
			h,
		);

		const run = readRecord("pulsar-ads", h)?.lastRun;
		expect(run?.status).toBe("ok");
		expect(run?.startedAt).toBe(startedAt as string);
		expect(run?.endedAt).toBeTruthy();
		expect(run?.stats.inserted).toBe(1214882);
		expect(run?.error).toBeNull();
	});

	test("finishRun com erro guarda a mensagem", () => {
		const h = home();
		writeRecord(base, h);
		finishRun(
			"pulsar-ads",
			{
				status: "error",
				exitCode: 1,
				stats: {},
				error: "ECONNREFUSED 127.0.0.1:27017",
			},
			h,
		);

		const run = readRecord("pulsar-ads", h)?.lastRun;
		expect(run?.status).toBe("error");
		expect(run?.error).toContain("ECONNREFUSED");
	});

	test("serviço sem registro não cria registro nenhum", () => {
		// Rodar `pulsar sync x.yml` à mão não é um serviço e não deve inventar um.
		const h = home();
		finishRun("pulsar-avulso", { status: "ok", exitCode: 0, stats: {} }, h);
		expect(readRecord("pulsar-avulso", h)).toBeNull();
	});

	test("serviceNameFromEnv lê a variável e devolve null sem ela", () => {
		process.env.PULSAR_SERVICE_NAME = "pulsar-x";
		expect(serviceNameFromEnv()).toBe("pulsar-x");
		delete process.env.PULSAR_SERVICE_NAME;
		expect(serviceNameFromEnv()).toBeNull();
	});

	test("um outcome final já gravado não pode ser sobrescrito por um posterior (mesma guarda do shutdown() do sync)", () => {
		// Reproduz o interleaving real: engine.start() rejeita, o catch de
		// sync.ts grava "error" e marca o flag; um SIGTERM chega DEPOIS e o
		// finally do shutdown() tentaria gravar "ok" por cima. Com a guarda
		// (`!outcomeRecorded`), a segunda escrita nunca acontece.
		const h = home();
		writeRecord(base, h);
		beginRun("pulsar-ads", h);

		let outcomeRecorded = false;

		// catch: grava o erro e marca o flag.
		finishRun(
			"pulsar-ads",
			{
				status: "error",
				exitCode: 1,
				stats: {},
				error: "ECONNREFUSED 127.0.0.1:27017",
			},
			h,
		);
		outcomeRecorded = true;

		// finally do shutdown(), chegando depois: a guarda impede a escrita.
		if (!outcomeRecorded) {
			finishRun("pulsar-ads", { status: "ok", exitCode: 0, stats: {} }, h);
		}

		const run = readRecord("pulsar-ads", h)?.lastRun;
		expect(run?.status).toBe("error");
		expect(run?.error).toContain("ECONNREFUSED");
	});
});

describe("describeError / isAlreadyHandled", () => {
	// errorHandler (src/errors/errorHandler.ts) loga a causa real e relança só
	// o breadcrumb colorido com chalk — força level 3 aqui pra garantir que os
	// códigos ANSI existam mesmo rodando `bun test` sem TTY (chalk desativa
	// cor automaticamente fora de terminal).
	const chalk = new Chalk({ level: 3 });

	test("Error de verdade (não passou por errorHandler): usa a .message", () => {
		const err = new Error("ECONNREFUSED 127.0.0.1:27017");
		expect(describeError(err)).toBe("ECONNREFUSED 127.0.0.1:27017");
		expect(isAlreadyHandled(err)).toBe(false);
	});

	test("string colorida (já passou por errorHandler): tira os códigos ANSI", () => {
		const colored = chalk.hex("#ff7c00").bold("CONN:MONGO:CLIENT");
		expect(colored).toContain("\x1b["); // confirma que o teste testa algo real
		expect(describeError(colored)).toBe("CONN:MONGO:CLIENT");
		expect(isAlreadyHandled(colored)).toBe(true);
	});

	test("valor não-Error e não-string: cai no String()", () => {
		expect(describeError(42)).toBe("42");
		expect(isAlreadyHandled(42)).toBe(false);
	});
});

describe("adopt", () => {
	test("extrai modo e yml de uma linha de comando", () => {
		expect(
			parseExecStart("/home/u/.local/bin/pulsar sync /srv/ads.yml"),
		).toEqual({
			mode: "sync",
			config: "/srv/ads.yml",
		});
	});

	test("funciona no modo código-fonte (bun + script)", () => {
		expect(
			parseExecStart(
				"/usr/bin/bun /home/u/pulsar/src/cli.ts migrate /srv/m.yml",
			),
		).toEqual({ mode: "migrate", config: "/srv/m.yml" });
	});

	test("ignora flags depois do yml", () => {
		expect(parseExecStart("pulsar sync /srv/ads.yml --verbose")).toEqual({
			mode: "sync",
			config: "/srv/ads.yml",
		});
	});

	test("linha sem modo conhecido devolve null", () => {
		expect(parseExecStart("/usr/bin/tail -f /var/log/x")).toBeNull();
	});

	test("adota uma unit do systemd", () => {
		const show = [
			"ExecStart={ path=/home/u/.local/bin/pulsar ; argv[]=/home/u/.local/bin/pulsar sync /srv/ads.yml ; ignore_errors=no }",
			"WorkingDirectory=/srv",
			"UnitFileState=enabled",
		].join("\n");

		expect(adoptFromSystemd("pulsar-ads", show)).toEqual({
			name: "pulsar-ads",
			mode: "sync",
			config: "/srv/ads.yml",
			workingDir: "/srv",
			backend: "systemd",
			boot: true,
			createdBy: "adotado",
			lastRun: null,
		});
	});

	test("unit sem ExecStart reconhecível não é adotada", () => {
		expect(adoptFromSystemd("pulsar-x", "WorkingDirectory=/srv")).toBeNull();
	});

	test("adota um container", () => {
		const record = adoptFromDocker(
			"pulsar-sync-loja",
			"sync /app/loja.yml",
			"/srv",
		);
		expect(record?.mode).toBe("sync");
		expect(record?.backend).toBe("docker");
		expect(record?.createdBy).toBe("adotado");
	});
});
