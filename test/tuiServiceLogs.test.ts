import { describe, expect, test } from "bun:test";
import { followIssue } from "../src/tui/screens/ServiceLogs";

/**
 * O diagnóstico da aba "serviço" — a parte que decide o que dizer quando o
 * painel está vazio.
 *
 * É aqui que mora a chance de erro: um painel vazio não distingue "o serviço
 * está quieto" de "o seguidor nem existe nesta máquina", e foi exatamente esse
 * genérico que a aba nasceu para não repetir.
 */

describe("followIssue", () => {
	test("seguidor vivo não é problema nenhum", () => {
		expect(followIssue("systemd", "running", [])).toBeNull();
		expect(followIssue("docker", "exited", ["tchau"])).toBeNull();
	});

	test("binário ausente é reportado pelo nome do seguidor", () => {
		const issue = followIssue("systemd", "failed", [
			"[ TUI ] falha ao iniciar: spawn journalctl ENOENT",
		]);
		expect(issue?.reason).toContain("journalctl");
		expect(issue?.short).toBe("journalctl ausente");
	});

	test("cada backend nomeia o próprio seguidor", () => {
		const issue = followIssue("docker", "failed", [
			"[ TUI ] falha ao iniciar: spawn docker ENOENT",
		]);
		expect(issue?.reason).toContain("docker");
	});

	test("systemd sem bus é dito com esse nome, não como 'falhou'", () => {
		const issue = followIssue("systemd", "failed", [
			"Failed to connect to bus: No medium found",
		]);
		expect(issue?.short).toBe("systemd sem bus");
		expect(issue?.reason).toContain("bus");
	});

	test("qualquer outra falha leva a última linha com conteúdo", () => {
		const issue = followIssue("docker", "failed", [
			"algo antes",
			"Error: No such container: pulsar-x",
			"",
			"   ",
		]);
		expect(issue?.reason).toContain("No such container: pulsar-x");
		expect(issue?.short).toBe("seguidor caiu");
	});

	test("falha sem nenhuma linha ainda diz alguma coisa", () => {
		const issue = followIssue("pm2", "failed", []);
		expect(issue?.reason).toContain("sem mensagem");
	});
});
