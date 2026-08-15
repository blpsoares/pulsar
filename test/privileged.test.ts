import { describe, expect, test } from "bun:test";
import { detectSudo, runPrivilegedStep } from "../src/core/service/privileged";
import type { ServiceStep } from "../src/core/service/types";
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
