import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	filterLines,
	listLogFiles,
	logWindow,
	readSince,
	tailFile,
} from "../src/core/logs/readLog";
import { tailCommand } from "../src/core/logs/tailCommand";
import { LineBuffer, levelOf, stripAnsi } from "../src/core/run/logLines";
import { argsFor, pulsarCommandLine } from "../src/core/run/pulsarCommand";
import { enableBootSteps } from "../src/core/service/enableBoot";
import { specFromRecord } from "../src/core/service/fromRecord";
import { buildPlist, launchdPlan } from "../src/core/service/launchd";
import { execStep } from "../src/core/service/manager";
import { buildEcosystem, pm2Plan } from "../src/core/service/pm2";
import { buildUnit, systemdPlan } from "../src/core/service/systemd";
import { type ServiceSpec, serviceName, slug } from "../src/core/service/types";
import type { ServiceRecord } from "../src/core/state/registry";

const spec: ServiceSpec = {
	name: "ads-staging",
	mode: "sync",
	configPath: "/srv/pulsar/ads.yml",
	workingDir: "/srv/pulsar",
	autostart: true,
};

const finiteSpec: ServiceSpec = { ...spec, name: "carga", mode: "migrate" };

describe("systemd", () => {
	test("a unit aponta para o comando real e para o yml absoluto", () => {
		const unit = buildUnit(spec);
		expect(unit).toContain("ExecStart=");
		expect(unit).toContain("/srv/pulsar/ads.yml");
		expect(unit).toContain("WorkingDirectory=/srv/pulsar");
		expect(unit).toContain("WantedBy=default.target");
	});

	test("sync reinicia sempre; migrate só em falha", () => {
		expect(buildUnit(spec)).toContain("Restart=always");
		const migrate = buildUnit(finiteSpec);
		expect(migrate).toContain("Restart=on-failure");
		expect(migrate).not.toContain("Restart=always");
	});

	test("dá tempo do shutdown gravar o resume token", () => {
		const unit = buildUnit(spec);
		expect(unit).toContain("KillSignal=SIGTERM");
		const timeout = Number(/TimeoutStopSec=(\d+)/.exec(unit)?.[1]);
		const shutdown = Number(/PULSAR_SHUTDOWN_TIMEOUT_MS=(\d+)/.exec(unit)?.[1]);
		expect(timeout * 1000).toBeGreaterThan(shutdown);
	});

	test("autostart inclui o enable-linger (sem ele nada sobe no boot)", () => {
		const plan = systemdPlan(spec);
		const cmds = plan.steps.map((s) => `${s.cmd} ${s.args.join(" ")}`);
		expect(cmds.some((c) => c.includes("enable-linger"))).toBe(true);
		expect(cmds.some((c) => c.includes("enable --now"))).toBe(true);

		const semBoot = systemdPlan({ ...spec, autostart: false });
		expect(
			semBoot.steps.some((s) => s.args.join(" ").includes("enable-linger")),
		).toBe(false);
	});

	test("nenhum passo automático usa sudo", () => {
		const plan = systemdPlan(spec);
		expect(plan.steps.some((s) => s.cmd === "sudo" || s.privileged)).toBe(
			false,
		);
		expect(plan.manualSteps.every((s) => s.privileged)).toBe(true);
	});
});

describe("launchd", () => {
	test("plist é XML válido com o comando em ProgramArguments", () => {
		const plist = buildPlist(spec);
		expect(plist).toStartWith('<?xml version="1.0"');
		expect(plist).toContain("<key>Label</key>");
		expect(plist).toContain("/srv/pulsar/ads.yml");
		expect(plist).toContain("<key>RunAtLoad</key>");
	});

	test("KeepAlive difere entre daemon e comando finito", () => {
		// sync: sempre de volta
		expect(buildPlist(spec)).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
		// migrate: só se sair com erro — senão rodaria em loop eterno
		expect(buildPlist(finiteSpec)).toContain("<key>SuccessfulExit</key>");
	});

	test("caracteres de XML nos caminhos são escapados", () => {
		const plist = buildPlist({
			...spec,
			configPath: "/srv/a&b/<x>.yml",
		});
		expect(plist).toContain("&amp;");
		expect(plist).toContain("&lt;x&gt;");
	});

	test("o plano avisa que LaunchAgent sobe no login, não no boot", () => {
		expect(launchdPlan(spec, 501).notes.join(" ")).toContain("LOGIN");
	});
});

describe("pm2", () => {
	test("ecosystem é JSON válido com interpreter none", () => {
		const parsed = JSON.parse(buildEcosystem(spec)) as {
			apps: { interpreter: string; autorestart: boolean; args: string[] }[];
		};
		const app = parsed.apps[0];
		expect(app?.interpreter).toBe("none");
		expect(app?.autorestart).toBe(true);
		expect(app?.args).toContain("/srv/pulsar/ads.yml");
	});

	test("migrate não fica reiniciando quando termina bem", () => {
		const parsed = JSON.parse(buildEcosystem(finiteSpec)) as {
			apps: { autorestart: boolean }[];
		};
		expect(parsed.apps[0]?.autorestart).toBe(false);
	});

	test("pm2 startup fica como passo manual (pede sudo)", () => {
		const plan = pm2Plan(spec);
		expect(plan.steps.some((s) => s.privileged)).toBe(false);
		expect(plan.manualSteps.some((s) => s.args.includes("startup"))).toBe(true);
	});
});

describe("nomes e comandos", () => {
	test("nome do serviço é derivado e sanitizado", () => {
		expect(serviceName({ name: "ads-staging" })).toBe("pulsar-ads-staging");
		expect(slug("Prod Sync.yml")).toBe("prod-sync");
		expect(slug("///")).toBe("pulsar");
	});

	test("linha de comando cita caminhos com espaço", () => {
		const line = pulsarCommandLine(argsFor("sync", "/srv/meu dir/a.yml"));
		expect(line).toContain('"/srv/meu dir/a.yml"');
	});

	test("cada backend usa o seguidor de log nativo", () => {
		const opts = { workingDir: "/srv/pulsar", label: "com.pulsar.x" };
		expect(tailCommand("systemd", "pulsar-x", opts).cmd).toBe("journalctl");
		expect(tailCommand("pm2", "pulsar-x", opts).args).toContain("--raw");
		expect(tailCommand("docker", "pulsar-x", opts).args).toContain("-f");
		expect(tailCommand("launchd", "pulsar-x", opts).cmd).toBe("tail");
	});
});

describe("LineBuffer", () => {
	test("junta chunk cortado no meio da linha", () => {
		const buf = new LineBuffer();
		buf.push("primeira linha\nsegun");
		buf.push("da linha\n");
		expect(buf.all()).toEqual(["primeira linha", "segunda linha"]);
	});

	test("remove escapes ANSI", () => {
		const buf = new LineBuffer();
		buf.push("[32mverde[39m\n");
		expect(buf.all()).toEqual(["verde"]);
		expect(stripAnsi("[1mx[0m")).toBe("x");
	});

	test("respeita o teto de linhas", () => {
		const buf = new LineBuffer(10);
		for (let i = 0; i < 100; i++) buf.push(`linha ${i}\n`);
		const all = buf.all();
		expect(all.length).toBe(10);
		expect(all.at(-1)).toBe("linha 99");
	});

	test("\\r vira quebra (barra de progresso não sobrescreve a tela)", () => {
		const buf = new LineBuffer();
		buf.push("10%\r20%\r30%\n");
		expect(buf.all()).toEqual(["10%", "20%", "30%"]);
	});

	test("classifica o nível pela linha", () => {
		expect(levelOf("[ ERROR ] deu ruim")).toBe("error");
		expect(levelOf("⚠ atenção")).toBe("warn");
		expect(levelOf("[ INFO ] tudo certo")).toBe("info");
	});
});

describe("leitura de log em arquivo", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-tui-"));
		const logs = join(dir, "logs");
		require("node:fs").mkdirSync(logs, { recursive: true });
		writeFileSync(
			join(logs, "debug.log"),
			`${Array.from({ length: 500 }, (_, i) => `linha ${i}`).join("\n")}\n`,
		);
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("lista os arquivos de log da pasta", () => {
		const files = listLogFiles(dir);
		expect(files.map((f) => f.name)).toContain("debug.log");
	});

	test("tail devolve as últimas N linhas inteiras", () => {
		const { lines } = tailFile(join(dir, "logs", "debug.log"), 5);
		expect(lines).toEqual([
			"linha 495",
			"linha 496",
			"linha 497",
			"linha 498",
			"linha 499",
		]);
	});

	test("readSince lê só o que cresceu", () => {
		const path = join(dir, "logs", "debug.log");
		const { size } = tailFile(path, 1);
		writeFileSync(path, "nova linha\n", { flag: "a" });

		const delta = readSince(path, size);
		expect(delta.lines).toEqual(["nova linha"]);
		expect(delta.size).toBeGreaterThan(size);
	});

	test("arquivo rotacionado (menor que o offset) volta pela cauda", () => {
		const path = join(dir, "logs", "rotacionado.log");
		writeFileSync(path, "curto\n");
		const { lines } = readSince(path, 999_999);
		expect(lines).toEqual(["curto"]);
	});

	test("filtro de busca é case-insensitive", () => {
		expect(filterLines(["Erro X", "ok"], "erro")).toEqual(["Erro X"]);
		expect(filterLines(["a", "b"], "  ")).toEqual(["a", "b"]);
	});
});

describe("janela de rolagem do log", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);

	test("scroll 0 mostra o fim (é o que 'seguir' significa)", () => {
		const { visible } = logWindow(lines, 0, 5);
		expect(visible).toEqual(["l95", "l96", "l97", "l98", "l99"]);
	});

	test("scroll conta a partir do fim", () => {
		expect(logWindow(lines, 10, 5).visible).toEqual([
			"l85",
			"l86",
			"l87",
			"l88",
			"l89",
		]);
	});

	test("não rola além do topo nem para trás do fim", () => {
		expect(logWindow(lines, 999, 5).scroll).toBe(95);
		expect(logWindow(lines, 999, 5).visible[0]).toBe("l0");
		expect(logWindow(lines, -3, 5).scroll).toBe(0);
	});

	test("log menor que a tela não rola", () => {
		const curto = ["a", "b"];
		expect(logWindow(curto, 5, 10)).toEqual({ visible: curto, scroll: 0 });
	});

	test("log vazio não quebra", () => {
		expect(logWindow([], 3, 10)).toEqual({ visible: [], scroll: 0 });
	});
});

/**
 * Os dois jeitos de o passo do docker morrer sem deixar nada de pé. Ambos vinham
 * do `execFile`, que era como os passos rodavam: teto fixo de 2 min e buffer de
 * 1 MB. O `docker compose up --build` é o único passo que constrói uma imagem —
 * na primeira vez leva minutos e cospe saída sem parar.
 */
describe("execução de um passo de serviço", () => {
	test("respeita o teto declarado pelo passo, e não um fixo", async () => {
		const r = await execStep(
			{ cmd: "sleep", args: ["30"], why: "passo lento", timeoutMs: 300 },
			{ cwd: process.cwd() },
		);
		expect(r.ok).toBe(false);
		expect(r.output).toContain("interrompido");
	});

	test("passo longo termina quando o teto permite", async () => {
		const r = await execStep(
			{ cmd: "sleep", args: ["1"], why: "passo lento", timeoutMs: 20_000 },
			{ cwd: process.cwd() },
		);
		expect(r.ok).toBe(true);
	});

	test("saída gigante não derruba o passo (execFile morria em 1 MB)", async () => {
		const r = await execStep(
			{
				cmd: "bash",
				args: [
					"-c",
					"for i in $(seq 1 60000); do echo linha-de-build-$i; done",
				],
				why: "passo verborrágico",
			},
			{ cwd: process.cwd() },
		);
		expect(r.ok).toBe(true);
		// Só a cauda é guardada — o relatório não precisa das 60 mil linhas.
		expect(r.output).toContain("linha-de-build-60000");
		expect(r.output.split("\n").length).toBeLessThanOrEqual(200);
	});

	test("código de saída != 0 reprova o passo", async () => {
		const r = await execStep(
			{ cmd: "bash", args: ["-c", "echo falhou >&2; exit 3"], why: "erro" },
			{ cwd: process.cwd() },
		);
		expect(r.ok).toBe(false);
		expect(r.output).toContain("falhou");
		expect(r.output).toContain("código 3");
	});

	test("comando inexistente não explode", async () => {
		const r = await execStep(
			{ cmd: "comando-que-nao-existe-pulsar", args: [], why: "?" },
			{ cwd: process.cwd() },
		);
		expect(r.ok).toBe(false);
	});
});

/**
 * Task 15 — o que a amarração acrescentou ao núcleo de serviço: converter um
 * REGISTRO em `ServiceSpec` (toda ação do painel parte daí) e religar o boot
 * que a instalação deixou pendente.
 */
describe("specFromRecord", () => {
	function record(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
		return {
			name: "pulsar-loja",
			mode: "sync",
			config: "/proj/loja.yml",
			workingDir: "/proj",
			backend: "systemd",
			boot: true,
			createdBy: "pulsar-tui",
			lastRun: null,
			...overrides,
		};
	}

	test("tira o prefixo do nome — `serviceName()` o reaplica sozinho", () => {
		const spec = specFromRecord(record());
		expect(spec.name).toBe("loja");
		// A ida e volta tem que fechar: é o nome que o supervisor conhece.
		expect(serviceName(spec)).toBe("pulsar-loja");
	});

	test("leva config, workingDir e boot como estão", () => {
		const spec = specFromRecord(record({ boot: false }));
		expect(spec.configPath).toBe("/proj/loja.yml");
		expect(spec.workingDir).toBe("/proj");
		expect(spec.autostart).toBe(false);
	});

	test("nome sem prefixo (registro de outra origem) passa intacto", () => {
		expect(specFromRecord(record({ name: "loja" })).name).toBe("loja");
	});
});

describe("enableBootSteps", () => {
	function record(backend: ServiceRecord["backend"]): ServiceRecord {
		return {
			name: "pulsar-loja",
			mode: "sync",
			config: "/proj/loja.yml",
			workingDir: "/proj",
			backend,
			boot: false,
			createdBy: "pulsar-tui",
			lastRun: null,
		};
	}

	test("systemd: habilita a unit e só cai no sudo se o linger automático falhar", () => {
		const steps = enableBootSteps(record("systemd"));
		expect(steps[0].args).toEqual(["--user", "enable", "pulsar-loja.service"]);
		// o automático é opcional (máquina sem polkit) e o manual só roda como
		// fallback DELE — senão pediria senha à toa
		expect(steps[1].optional).toBe(true);
		expect(steps[1].id).toBe("linger");
		expect(steps[2].privileged).toBe(true);
		expect(steps[2].fallbackFor).toBe("linger");
	});

	test("docker: política de restart + o próprio Docker no boot (esse é o com sudo)", () => {
		const steps = enableBootSteps(record("docker"));
		expect(steps[0].args).toEqual([
			"update",
			"--restart=unless-stopped",
			"pulsar-loja",
		]);
		expect(steps.at(-1)?.privileged).toBe(true);
	});

	test("pm2: save automático, startup como passo privilegiado", () => {
		const steps = enableBootSteps(record("pm2"));
		expect(steps.map((s) => s.args.join(" "))).toEqual(["save", "startup"]);
		expect(steps[0].privileged).toBeUndefined();
		expect(steps[1].privileged).toBe(true);
	});

	test("launchd: lista VAZIA — RunAtLoad mora no plist, ligar é reinstalar", () => {
		// Vazio não é omissão: é o que faz a tela dizer "edite e reinstale" em
		// vez de fingir que rodou algo.
		expect(enableBootSteps(record("launchd"))).toEqual([]);
	});
});
