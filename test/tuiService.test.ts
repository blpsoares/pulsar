import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	filterLines,
	listLogFiles,
	readSince,
	tailFile,
} from "../src/core/logs/readLog";
import { tailCommand } from "../src/core/logs/tailCommand";
import { LineBuffer, levelOf, stripAnsi } from "../src/core/run/logLines";
import { argsFor, pulsarCommandLine } from "../src/core/run/pulsarCommand";
import {
	detectBackends,
	judgeSystemdUser,
	preferredBackend,
	type SystemdProbe,
} from "../src/core/service/detect";
import { dockerPlan } from "../src/core/service/dockerService";
import { buildPlist, launchdPlan } from "../src/core/service/launchd";
import { adviseFailure, stepFailure } from "../src/core/service/manager";
import { buildEcosystem, pm2Plan } from "../src/core/service/pm2";
import { buildUnit, systemdPlan } from "../src/core/service/systemd";
import { type ServiceSpec, serviceName, slug } from "../src/core/service/types";

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

describe("detecção de systemd de usuário", () => {
	const vivo: SystemdProbe = {
		systemAsInit: true,
		userBusSocket: true,
		cli: { ok: true, stdout: "running\n", stderr: "" },
	};

	test("bus ausente reprova mesmo saindo com código numérico (WSL)", () => {
		// O caso do usuário: systemctl existe, roda, sai 1 — e o motivo real só
		// aparece no stderr, que a versão antiga jogava fora.
		const v = judgeSystemdUser({
			systemAsInit: true,
			userBusSocket: false,
			cli: {
				ok: false,
				stdout: "",
				stderr: "Failed to connect to bus: No medium found\n",
			},
		});
		expect(v.available).toBe(false);
		expect(v.reason).toContain("bus");
		expect(v.fix).toContain("docker");
	});

	test("outras frases da mesma família também reprovam", () => {
		for (const stderr of [
			"Failed to get D-Bus connection: Operation not permitted",
			"Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
		]) {
			expect(
				judgeSystemdUser({ ...vivo, cli: { ok: false, stdout: "", stderr } })
					.available,
			).toBe(false);
		}
	});

	test("sem systemd como init reprova antes de qualquer coisa", () => {
		expect(judgeSystemdUser({ ...vivo, systemAsInit: false }).available).toBe(
			false,
		);
	});

	test("degraded continua valendo: sai != 0 mas tem bus e estado", () => {
		const v = judgeSystemdUser({
			systemAsInit: true,
			userBusSocket: true,
			cli: { ok: false, stdout: "degraded\n", stderr: "" },
		});
		expect(v.available).toBe(true);
		expect(v.reason).toBeUndefined();
	});

	test("systemctl ausente reprova com motivo próprio", () => {
		const v = judgeSystemdUser({ ...vivo, cli: null });
		expect(v.available).toBe(false);
		expect(v.reason).toContain("PATH");
	});

	test("numa máquina WSL o preferido cai em docker", async () => {
		const availability = await detectBackends(true, {
			os: "linux",
			systemdProbe: async () => ({
				systemAsInit: false,
				userBusSocket: false,
				cli: {
					ok: false,
					stdout: "",
					stderr: "Failed to connect to bus: No medium found",
				},
			}),
		});

		expect(availability.find((a) => a.backend === "systemd")?.available).toBe(
			false,
		);

		// preferredBackend é puro: monta-se a disponibilidade do cenário (docker
		// no ar, pm2 não) para não depender do que existe na máquina do CI.
		const cenario = availability.map((a) =>
			a.backend === "docker"
				? { ...a, available: true }
				: { ...a, available: false },
		);
		expect(preferredBackend(cenario, "linux")).toBe("docker");
	});

	test("sem nenhum backend disponível, não inventa um", () => {
		expect(
			preferredBackend(
				(["systemd", "docker", "pm2", "launchd"] as const).map((backend) => ({
					backend,
					available: false,
				})),
				"linux",
			),
		).toBe(null);
	});
});

describe("docker", () => {
	let dir: string;
	const res = { memLimitMiB: 1200, memReservMiB: 600, cpus: 0.8 };

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-docker-"));
		copyFileSync(
			fileURLToPath(new URL("../docker-compose-limit.yml", import.meta.url)),
			join(dir, "docker-compose-limit.yml"),
		);
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const dockerSpec = (): ServiceSpec => ({
		name: "ads",
		mode: "sync",
		configPath: join(dir, "ads.yml"),
		workingDir: dir,
		autostart: true,
	});

	test("autostart NÃO gera passo privilegiado (restart policy já basta)", () => {
		const plan = dockerPlan(dockerSpec(), res, {
			systemdSystem: false,
			unitEnabled: null,
		});
		expect("error" in plan).toBe(false);
		if ("error" in plan) return;

		expect(plan.manualSteps).toEqual([]);
		expect(plan.steps.some((s) => s.cmd === "sudo" || s.privileged)).toBe(
			false,
		);
		expect(plan.notes.join(" ")).not.toContain("systemctl enable docker");
	});

	test("só avisa do boot quando há systemd de sistema E docker desabilitado", () => {
		const desabilitado = dockerPlan(dockerSpec(), res, {
			systemdSystem: true,
			unitEnabled: false,
		});
		if ("error" in desabilitado) throw new Error(desabilitado.error);
		expect(desabilitado.notes.join(" ")).toContain("DESABILITADO");
		expect(desabilitado.manualSteps).toEqual([]);

		const habilitado = dockerPlan(dockerSpec(), res, {
			systemdSystem: true,
			unitEnabled: true,
		});
		if ("error" in habilitado) throw new Error(habilitado.error);
		expect(habilitado.notes.join(" ")).not.toContain("DESABILITADO");
	});

	test("sem autostart nem sonda o boot do daemon", () => {
		const plan = dockerPlan({ ...dockerSpec(), autostart: false }, res, {
			systemdSystem: true,
			unitEnabled: false,
		});
		if ("error" in plan) throw new Error(plan.error);
		expect(plan.notes.join(" ")).not.toContain("DESABILITADO");
	});
});

describe("falha de passo acionável", () => {
	test("a mensagem traz comando, causa e a saída sugerida", () => {
		const step = {
			cmd: "systemctl",
			args: ["--user", "daemon-reload"],
			why: "x",
		};
		const advice = adviseFailure(
			"systemd",
			"Failed to connect to bus: No medium found",
		);
		const msg = stepFailure(
			step,
			"Failed to connect to bus: No medium found",
			advice,
		);

		expect(msg).toContain("systemctl --user daemon-reload");
		expect(msg).toContain("No medium found");
		expect(msg).toMatch(/docker|pm2/);
	});

	test("falha desconhecida ainda sugere trocar de backend", () => {
		expect(adviseFailure("systemd", "erro esquisito")).toContain("troque");
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
