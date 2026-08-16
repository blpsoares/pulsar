import { describe, expect, test } from "bun:test";
import type { StepResult } from "../src/core/service/execStep";
import {
	disableBootSteps,
	shouldDisableBoot,
} from "../src/core/service/oneshot";
import { detectSudo, runPrivilegedStep } from "../src/core/service/privileged";
import {
	pickInstallError,
	switchBackend,
} from "../src/core/service/switchBackend";
import type { ServiceStep } from "../src/core/service/types";
import { CREATED_BY_TUI, type ServiceRecord } from "../src/core/state/registry";
import { DISABLE_MOUSE, ENTER_ALT, LEAVE_ALT } from "../src/core/tty/ansi";
import { withTerminal } from "../src/core/tty/handoff";

function fakeIo() {
	const written: string[] = [];
	const raw: boolean[] = [];
	return {
		written,
		raw,
		io: {
			stdout: { write: (s: string) => void written.push(s) },
			stdin: { isTTY: true, setRawMode: (v: boolean) => void raw.push(v) },
		},
	};
}

describe("withTerminal", () => {
	test("solta e retoma o terminal em volta da função", async () => {
		const { written, raw, io } = fakeIo();
		await withTerminal(async () => "ok", io);

		const all = written.join("");
		expect(all).toContain(LEAVE_ALT);
		expect(all).toContain(DISABLE_MOUSE);
		expect(all).toContain(ENTER_ALT);
		// solta o raw mode e devolve
		expect(raw).toEqual([false, true]);
	});

	test("restaura MESMO quando a função joga", async () => {
		// É o teste que importa: falhar aqui deixa o terminal do usuário sem eco.
		const { written, raw, io } = fakeIo();
		await expect(
			withTerminal(async () => {
				throw new Error("sudo falhou");
			}, io),
		).rejects.toThrow("sudo falhou");

		expect(written.join("")).toContain(ENTER_ALT);
		expect(raw).toEqual([false, true]);
	});

	test("devolve o valor da função", async () => {
		const { io } = fakeIo();
		expect(await withTerminal(async () => 42, io)).toBe(42);
	});

	test("sem TTY não tenta mexer em raw mode", async () => {
		const written: string[] = [];
		await withTerminal(async () => null, {
			stdout: { write: (s: string) => void written.push(s) },
			stdin: { isTTY: false },
		});
		expect(written.join("")).toBe("");
	});
});

describe("detectSudo", () => {
	test("sudo -n passando é passwordless", async () => {
		expect(await detectSudo(async () => true)).toBe("passwordless");
	});

	test("sudo -n falhando pede senha", async () => {
		expect(await detectSudo(async () => false)).toBe("needs-password");
	});
});

describe("runPrivilegedStep", () => {
	test("sem senha, roda sem perguntar nada", async () => {
		let perguntou = false;
		const result = await runPrivilegedStep(
			{ cmd: "true", args: [], why: "x", privileged: true },
			{
				cwd: process.cwd(),
				sudo: "passwordless",
				ask: async () => {
					perguntou = true;
					return true;
				},
			},
		);
		expect(perguntou).toBe(false);
		expect(result?.ok).toBe(true);
	});

	test("com senha, pergunta ANTES de rodar", async () => {
		const vistos: ServiceStep[] = [];
		await runPrivilegedStep(
			{ cmd: "true", args: [], why: "x", privileged: true },
			{
				cwd: process.cwd(),
				sudo: "needs-password",
				ask: async (s) => {
					vistos.push(s);
					return true;
				},
			},
		);
		// O usuário vê o comando literal antes de qualquer coisa acontecer.
		expect(vistos).toHaveLength(1);
		expect(vistos[0]?.cmd).toBe("true");
	});

	/**
	 * O `sudo` só desenha o prompt de senha se receber o TERMINAL. Com o
	 * `stdio: ["ignore","pipe","pipe"]` do caminho normal ele nasce sem stdin e
	 * morre com "a terminal is required to read the password" — o `withTerminal`
	 * largava a tela para ninguém. Como não há como capturar a saída E entregar
	 * o TTY ao mesmo tempo, o sinal observável de que o filho herdou o terminal
	 * é justamente `output` VAZIO num comando que imprime.
	 */
	test("com senha, o filho HERDA o terminal (sem isso o sudo não consegue perguntar)", async () => {
		const step: ServiceStep = {
			cmd: "sh",
			args: ["-c", "echo pulsar_saida_do_filho"],
			why: "x",
			privileged: true,
		};

		const interativo = await runPrivilegedStep(step, {
			cwd: process.cwd(),
			sudo: "needs-password",
			ask: async () => true,
		});
		expect(interativo?.ok).toBe(true);
		expect(interativo?.output).toBe("");

		// O contraste: sem senha não há prompt, e a saída continua capturada
		// (é ela que explica a falha de um passo no relatório).
		const capturado = await runPrivilegedStep(step, {
			cwd: process.cwd(),
			sudo: "passwordless",
			ask: async () => true,
		});
		expect(capturado?.output).toContain("pulsar_saida_do_filho");
	});

	test("recusar devolve null e não roda", async () => {
		const result = await runPrivilegedStep(
			{ cmd: "false", args: [], why: "x", privileged: true },
			{ cwd: process.cwd(), sudo: "needs-password", ask: async () => false },
		);
		expect(result).toBeNull();
	});
});

describe("installService com passo privilegiado", () => {
	test("pular o privilegiado não falha a instalação", async () => {
		// Era o comportamento antigo travestido de erro: o serviço subia, mas o
		// relatório dizia que a instalação tinha falhado.
		const { installService } = await import("../src/core/service/manager");
		const plan = {
			backend: "systemd" as const,
			serviceName: "pulsar-x",
			files: [],
			steps: [
				{ cmd: "true", args: [], why: "passo normal" },
				{ cmd: "true", args: [], why: "passo root", privileged: true },
			],
			manualSteps: [],
			notes: [],
		};
		const spec = {
			name: "x",
			mode: "sync" as const,
			configPath: "/tmp/x.yml",
			workingDir: "/tmp",
			autostart: true,
		};

		const result = await installService(plan, spec, {
			sudo: "needs-password",
			ask: async () => false,
		});
		expect(result.ok).toBe(true);
		expect(result.skippedPrivileged).toHaveLength(1);
	});
});

describe("installService roda plan.manualSteps (rodada de fix 1/5)", () => {
	// Sem isto, os três `privileged: true` reais do projeto (loginctl do
	// systemd, `systemctl enable docker`, `pm2 startup`) vivem só em
	// `manualSteps` — que `installService` nunca varria — e `runPrivilegedStep`
	// nunca era chamado em produção.
	const spec = {
		name: "x",
		mode: "sync" as const,
		configPath: "/tmp/x.yml",
		workingDir: "/tmp",
		autostart: true,
	};

	test("manualSteps privilegiado com sudo passwordless RODA", async () => {
		const { installService } = await import("../src/core/service/manager");
		const plan = {
			backend: "systemd" as const,
			serviceName: "pulsar-x",
			files: [],
			steps: [],
			manualSteps: [
				{ cmd: "true", args: [], why: "manual root", privileged: true },
			],
			notes: [],
		};

		const result = await installService(plan, spec, { sudo: "passwordless" });
		expect(result.ok).toBe(true);
		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.ok).toBe(true);
		expect(result.skippedPrivileged).toHaveLength(0);
	});

	test("manualSteps privilegiado recusado entra em skippedPrivileged e ok continua true", async () => {
		const { installService } = await import("../src/core/service/manager");
		const plan = {
			backend: "systemd" as const,
			serviceName: "pulsar-x",
			files: [],
			steps: [],
			manualSteps: [
				{ cmd: "false", args: [], why: "manual root", privileged: true },
			],
			notes: [],
		};

		const result = await installService(plan, spec, {
			sudo: "needs-password",
			ask: async () => false,
		});
		expect(result.ok).toBe(true);
		expect(result.results).toHaveLength(0);
		expect(result.skippedPrivileged).toHaveLength(1);
	});

	test("fallbackFor pula o manual quando o passo automático SUCEDEU — ask nunca é chamado", async () => {
		const { installService } = await import("../src/core/service/manager");
		let perguntou = false;
		const plan = {
			backend: "systemd" as const,
			serviceName: "pulsar-x",
			files: [],
			steps: [
				{ id: "linger", cmd: "true", args: [], why: "linger automático" },
			],
			manualSteps: [
				{
					fallbackFor: "linger",
					cmd: "sudo",
					args: ["loginctl", "enable-linger"],
					why: "só se o automático falhar",
					privileged: true,
				},
			],
			notes: [],
		};

		const result = await installService(plan, spec, {
			sudo: "needs-password",
			ask: async () => {
				perguntou = true;
				return true;
			},
		});

		expect(perguntou).toBe(false);
		expect(result.skippedPrivileged).toHaveLength(0);
		// só o passo automático rodou — o manual foi pulado, não executado nem recusado
		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.step.id).toBe("linger");
	});

	test("fallbackFor OFERECE o manual quando o passo automático FALHOU — ask é chamado", async () => {
		const { installService } = await import("../src/core/service/manager");
		let perguntou = false;
		const plan = {
			backend: "systemd" as const,
			serviceName: "pulsar-x",
			files: [],
			steps: [
				{
					id: "linger",
					cmd: "false",
					args: [],
					why: "linger automático",
					optional: true,
				},
			],
			manualSteps: [
				{
					fallbackFor: "linger",
					cmd: "true",
					args: [],
					why: "só se o automático falhar",
					privileged: true,
				},
			],
			notes: [],
		};

		const result = await installService(plan, spec, {
			sudo: "needs-password",
			ask: async () => {
				perguntou = true;
				return true;
			},
		});

		expect(perguntou).toBe(true);
		expect(result.ok).toBe(true);
		// automático (falhou, optional) + manual (rodou de verdade)
		expect(result.results).toHaveLength(2);
		expect(result.results[1]?.ok).toBe(true);
	});
});

const oneShot: ServiceRecord = {
	name: "pulsar-migra",
	mode: "migrate",
	config: "/srv/m.yml",
	workingDir: "/srv",
	backend: "systemd",
	boot: true,
	createdBy: CREATED_BY_TUI,
	lastRun: null,
};

describe("shouldDisableBoot", () => {
	test("one-shot criado pelo pulsar, concluído com sucesso: desliga", () => {
		expect(shouldDisableBoot(oneShot, "ok")).toBe(true);
	});

	test("erro NÃO desliga — senão a retentativa some sem ninguém saber", () => {
		expect(shouldDisableBoot(oneShot, "error")).toBe(false);
	});

	test("serviço que o pulsar não criou fica intocado", () => {
		expect(shouldDisableBoot({ ...oneShot, createdBy: "adotado" }, "ok")).toBe(
			false,
		);
	});

	test("sync nunca desliga o boot", () => {
		expect(shouldDisableBoot({ ...oneShot, mode: "sync" }, "ok")).toBe(false);
	});

	test("boot já desligado não faz nada", () => {
		expect(shouldDisableBoot({ ...oneShot, boot: false }, "ok")).toBe(false);
	});
});

describe("disableBootSteps", () => {
	test("systemd", () => {
		const [step] = disableBootSteps(oneShot);
		expect(step?.cmd).toBe("systemctl");
		expect(step?.args).toEqual(["--user", "disable", "pulsar-migra.service"]);
	});

	test("docker mira o CONTAINER (pulsar-sync-x), não o nome do registro", () => {
		const [step] = disableBootSteps({ ...oneShot, backend: "docker" });
		expect(step?.cmd).toBe("docker");
		expect(step?.args).toEqual(["update", "--restart=no", "pulsar-sync-migra"]);
	});

	test("launchd mira com.pulsar.migra — não com.pulsar.pulsar-migra", () => {
		// `record.name` já vem prefixado; reaplicar o prefixo dava um label que
		// não existe. O bootout falhava, e o registro carimbava boot:false
		// mentindo — o agent continuava subindo no login.
		const [step] = disableBootSteps({ ...oneShot, backend: "launchd" });
		expect(step?.cmd).toBe("launchctl");
		expect(step?.args[1]).toMatch(/^gui\/\d+\/com\.pulsar\.migra$/);
	});

	test("pm2 remove e salva", () => {
		const steps = disableBootSteps({ ...oneShot, backend: "pm2" });
		expect(steps.map((s) => s.args.join(" "))).toEqual([
			"delete pulsar-migra",
			"save",
		]);
	});
});

const record: ServiceRecord = { ...oneShot, mode: "sync", backend: "systemd" };

describe("switchBackend", () => {
	test("caminho feliz: desinstala do antigo, instala no novo, atualiza o registro", async () => {
		const ordem: string[] = [];
		const result = await switchBackend(record, "docker", {
			home: undefined,
			uninstall: async (backend) => {
				ordem.push(`uninstall:${backend}`);
				return { ok: true };
			},
			install: async (backend) => {
				ordem.push(`install:${backend}`);
				return { ok: true };
			},
			save: (r) => void ordem.push(`save:${r.backend}`),
		});

		expect(ordem).toEqual([
			"uninstall:systemd",
			"install:docker",
			"save:docker",
		]);
		expect(result.ok).toBe(true);
	});

	test("falhando no novo, volta para o antigo", async () => {
		// Sem isto, um docker mal configurado deixaria o usuário sem serviço
		// nenhum: o antigo já foi removido quando o novo falhou.
		const ordem: string[] = [];
		const result = await switchBackend(record, "docker", {
			home: undefined,
			uninstall: async (backend) => {
				ordem.push(`uninstall:${backend}`);
				return { ok: true };
			},
			install: async (backend) => {
				ordem.push(`install:${backend}`);
				return backend === "docker"
					? { ok: false, error: "daemon não responde" }
					: { ok: true };
			},
			save: () => {},
		});

		expect(ordem).toEqual([
			"uninstall:systemd",
			"install:docker",
			"install:systemd",
		]);
		expect(result).toEqual({
			ok: false,
			error: "daemon não responde",
			rolledBack: true,
		});
	});

	test("se nem o rollback funciona, diz isso em vez de mentir", async () => {
		const result = await switchBackend(record, "docker", {
			home: undefined,
			uninstall: async () => ({ ok: true }),
			install: async () => ({ ok: false, error: "nada funciona" }),
			save: () => {},
		});
		expect(result).toEqual({
			ok: false,
			error: "nada funciona",
			rolledBack: false,
		});
	});

	test("antigo que NÃO caiu aborta a troca — dois no mesmo destino é proibido", async () => {
		// Dois `sync` na mesma config disputam o resume token global em `__sync`
		// e duplicam escrita no destino. Antes o resultado do uninstall era
		// descartado e o novo subia por cima do antigo ainda vivo.
		const ordem: string[] = [];
		const result = await switchBackend(record, "docker", {
			home: undefined,
			uninstall: async (backend) => {
				ordem.push(`uninstall:${backend}`);
				return { ok: false, detail: "active (running)" };
			},
			install: async (backend) => {
				ordem.push(`install:${backend}`);
				return { ok: true };
			},
			save: () => void ordem.push("save"),
		});

		expect(ordem).toEqual(["uninstall:systemd"]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("systemd");
			expect(result.error).toContain("active (running)");
			// o antigo nunca saiu: continua havendo exatamente um serviço de pé
			expect(result.rolledBack).toBe(true);
		}
	});

	test("trocar para o mesmo backend não faz nada", async () => {
		const ordem: string[] = [];
		const result = await switchBackend(record, "systemd", {
			home: undefined,
			uninstall: async () => {
				ordem.push("uninstall");
				return { ok: true };
			},
			install: async () => {
				ordem.push("install");
				return { ok: true };
			},
			save: () => {},
		});
		expect(ordem).toEqual([]);
		expect(result.ok).toBe(true);
	});
});

function fakeResult(
	output: string,
	opts: { ok?: boolean; optional?: boolean } = {},
): StepResult {
	return {
		step: {
			cmd: "x",
			args: [],
			why: "teste",
			optional: opts.optional,
		},
		ok: opts.ok ?? false,
		output,
	};
}

describe("pickInstallError", () => {
	test("passo opcional falho ANTES do essencial: o motivo é o essencial, não o opcional", () => {
		// É o teste que impede a regressão: sem isto, "pm2 delete: process not
		// found" (opcional, falha rotineira) apareceria como motivo no lugar de
		// "pm2 start: ecosystem file inválido" (o que de fato quebrou a troca).
		const results = [
			fakeResult("pm2 delete: process not found", { optional: true }),
			fakeResult("pm2 start: ecosystem file inválido"),
		];

		expect(pickInstallError(results)).toBe(
			"pm2 start: ecosystem file inválido",
		);
	});

	test("só falha opcional: usa a última como melhor pista disponível", () => {
		const results = [
			fakeResult("primeira falha opcional", { optional: true }),
			fakeResult("última falha opcional", { optional: true }),
			fakeResult("passo essencial ok", { ok: true }),
		];

		expect(pickInstallError(results)).toBe("última falha opcional");
	});

	test("nenhum passo falhou: mensagem genérica", () => {
		expect(pickInstallError([fakeResult("tudo bem", { ok: true })])).toBe(
			"a instalação falhou sem mensagem",
		);
	});
});
