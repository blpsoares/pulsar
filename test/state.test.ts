import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	finishRun,
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
});
