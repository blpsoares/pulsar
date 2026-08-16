import { join } from "node:path";
import { argsFor, pulsarCommand } from "../run/pulsarCommand";
import { type InstallPlan, type ServiceSpec, serviceName } from "./types";

/**
 * pm2 — o backend portátil: mesmo comportamento em Linux e macOS.
 *
 * Em vez de montar uma linha `pm2 start ... -- args` (que quebra feio quando o
 * pulsar está rodando via `bun src/cli.ts`, porque o script vira argumento do
 * interpretador), geramos um **ecosystem file**. Ele descreve script, args,
 * cwd e env de forma explícita, fica versionável ao lado do yml e é o que o
 * pm2 relê quando reinicia.
 *
 * Autostart aqui é em dois tempos e o segundo NÃO é automatizável: `pm2 save`
 * congela a lista de processos, mas fazer o pm2 subir no boot exige instalar
 * um serviço de sistema (`pm2 startup`), que pede root. A TUI mostra o comando
 * e deixa a decisão com o usuário em vez de invocar sudo por conta própria.
 */

export function ecosystemPath(spec: ServiceSpec): string {
	return join(spec.workingDir, `${serviceName(spec)}.pm2.json`);
}

export function buildEcosystem(spec: ServiceSpec): string {
	const { cmd, args } = pulsarCommand(
		argsFor(spec.mode, spec.configPath, spec.extraArgs ?? []),
	);
	const isSync = spec.mode === "sync";

	const app = {
		name: serviceName(spec),
		script: cmd,
		args,
		cwd: spec.workingDir,
		// `interpreter: none` é obrigatório: sem isso o pm2 tenta executar o
		// binário com node e falha na hora.
		interpreter: "none",
		autorestart: isSync,
		// migrate/ttl terminam sozinhos; reiniciar seria refazer o trabalho.
		restart_delay: 10_000,
		max_restarts: isSync ? 0 : 3,
		kill_timeout: 45_000,
		error_file: join(spec.workingDir, "logs", `${serviceName(spec)}.err.log`),
		out_file: join(spec.workingDir, "logs", `${serviceName(spec)}.out.log`),
		env: {
			// Diz ao processo QUE SERVIÇO ele é: sem isso ele não grava o resultado
			// da execução no registro (~/.pulsar/services) e um one-shot concluído
			// não desliga o próprio boot.
			PULSAR_SERVICE_NAME: serviceName(spec),
			PULSAR_SHUTDOWN_TIMEOUT_MS: "30000",
			STATUS_INTERVAL_MS: "30000",
			NO_COLOR: "1",
		},
	};

	return `${JSON.stringify({ apps: [app] }, null, 2)}\n`;
}

export function pm2Plan(spec: ServiceSpec): InstallPlan {
	const name = serviceName(spec);
	const file = ecosystemPath(spec);

	const steps = [
		{
			cmd: "pm2",
			args: ["delete", name],
			why: "remove uma instância anterior com o mesmo nome",
			optional: true,
		},
		{ cmd: "pm2", args: ["start", file], why: "inicia a partir do ecosystem" },
	];

	const manualSteps: InstallPlan["manualSteps"] = [];
	const notes: string[] = [];

	if (spec.autostart) {
		steps.push({
			cmd: "pm2",
			args: ["save"],
			why: "congela a lista atual para o pm2 restaurar no boot",
		});
		manualSteps.push({
			cmd: "pm2",
			args: ["startup"],
			why: "imprime o comando com sudo que instala o pm2 no boot — rode você mesmo",
			privileged: true,
		});
		notes.push(
			"O autostart do pm2 só fica completo depois de rodar o comando que o 'pm2 startup' imprime (ele pede sudo).",
		);
	}

	// kill_timeout do pm2 é o prazo entre SIGINT e SIGKILL — o pulsar precisa
	// dele para gravar o resume token.
	notes.push(
		"O pm2 envia SIGINT ao parar; o pulsar trata e faz flush do resume token antes de sair.",
	);

	return {
		backend: "pm2",
		serviceName: name,
		files: [{ path: file, content: buildEcosystem(spec) }],
		steps,
		manualSteps,
		notes,
	};
}

export function pm2UninstallSteps(name: string) {
	return [
		{
			cmd: "pm2",
			args: ["delete", name],
			why: "para e remove do pm2",
			optional: true,
		},
		{
			cmd: "pm2",
			args: ["save"],
			why: "atualiza a lista salva",
			optional: true,
		},
	];
}
