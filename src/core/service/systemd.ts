import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { argsFor, pulsarCommand } from "../run/pulsarCommand";
import {
	type InstallPlan,
	type ServiceSpec,
	type ServiceStep,
	serviceName,
} from "./types";

/**
 * systemd em modo USER (`systemctl --user`), não system.
 *
 * A escolha é deliberada: uma unit de usuário é instalada em `~/.config` sem
 * sudo nenhum, e roda com as credenciais e o ambiente de quem usa o pulsar
 * (inclusive `~/.local/bin/pulsar`). Uma unit de sistema exigiria root para
 * qualquer alteração e rodaria como outro usuário — que provavelmente não
 * enxerga o mesmo binário nem o mesmo diretório de configs.
 *
 * O preço é uma pegadinha conhecida: por padrão o systemd encerra os serviços
 * do usuário no logout, e não os inicia no boot antes do login. `loginctl
 * enable-linger` é o que corrige isso — sem ele, "iniciar junto com o sistema"
 * simplesmente não acontece numa VM headless. Por isso o passo faz parte do
 * plano, não é uma dica no rodapé.
 */

export function unitDir(): string {
	return join(homedir(), ".config", "systemd", "user");
}

export function unitPath(spec: ServiceSpec): string {
	return join(unitDir(), `${serviceName(spec)}.service`);
}

export function buildUnit(spec: ServiceSpec): string {
	const { cmd, args } = pulsarCommand(
		argsFor(spec.mode, spec.configPath, spec.extraArgs ?? []),
	);
	const execStart = [cmd, ...args].map(escapeExec).join(" ");
	const isSync = spec.mode === "sync";

	return `# Gerado pelo pulsar (tui). Editar à mão é permitido:
# depois rode 'systemctl --user daemon-reload'.
[Unit]
Description=pulsar ${spec.mode} (${spec.name})
# network-online garante que o DNS do Atlas resolve na primeira tentativa;
# sem isso o serviço sobe antes da rede e cai no retry logo no boot.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${spec.workingDir}
ExecStart=${execStart}
${
	isSync
		? `# sync é um daemon: sempre voltar.
Restart=always
RestartSec=10`
		: `# migrate/ttl terminam sozinhos: reiniciar só em falha, com teto de tentativas.
Restart=on-failure
RestartSec=30
StartLimitBurst=3`
}
# TimeoutStopSec > PULSAR_SHUTDOWN_TIMEOUT_MS: o pulsar precisa desse tempo
# para gravar o resume token antes de sair. Cortar antes força re-dump.
TimeoutStopSec=45
KillSignal=SIGTERM
Environment=PULSAR_SHUTDOWN_TIMEOUT_MS=30000
# Sem TTY as barras de progresso são desligadas e entra o bloco STATUS.
Environment=STATUS_INTERVAL_MS=30000
Environment=NO_COLOR=1
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${serviceName(spec)}

[Install]
WantedBy=default.target
`;
}

export function systemdPlan(spec: ServiceSpec): InstallPlan {
	const name = serviceName(spec);
	const unit = `${name}.service`;

	const steps: ServiceStep[] = [
		{
			cmd: "systemctl",
			args: ["--user", "daemon-reload"],
			why: "recarrega as units para o systemd enxergar o arquivo novo",
		},
		{
			cmd: "systemctl",
			args: ["--user", "enable", "--now", unit],
			why: "habilita no boot e inicia agora",
		},
	];

	const notes: string[] = [];
	const manualSteps: InstallPlan["manualSteps"] = [];

	if (spec.autostart) {
		// enable-linger normalmente funciona sem sudo (policykit permite ao
		// próprio usuário), mas em máquina sem polkit cai para o comando manual.
		steps.splice(1, 0, {
			id: "linger",
			cmd: "loginctl",
			args: ["enable-linger", userInfo().username],
			why: "permite o serviço subir no boot SEM ninguém fazer login",
			optional: true,
		});
		manualSteps.push({
			fallbackFor: "linger",
			cmd: "sudo",
			args: ["loginctl", "enable-linger", userInfo().username],
			why: "só se o passo automático de linger tiver falhado acima",
			privileged: true,
		});
	} else {
		notes.push(
			"Sem autostart: o serviço não sobe no boot nem depois do logout.",
		);
	}

	return {
		backend: "systemd",
		serviceName: name,
		files: [{ path: unitPath(spec), content: buildUnit(spec) }],
		steps,
		manualSteps,
		notes,
	};
}

export function systemdUninstallSteps(name: string) {
	return [
		{
			cmd: "systemctl",
			args: ["--user", "disable", "--now", `${name}.service`],
			why: "para o serviço e tira do boot",
			optional: true,
		},
		{
			cmd: "systemctl",
			args: ["--user", "daemon-reload"],
			why: "recarrega depois de remover a unit",
		},
	];
}

/**
 * ExecStart do systemd trata `%` como especificador (ex.: `%h` = home) — um
 * caminho com `%` viraria outra coisa. Duplicar é o escape documentado.
 */
function escapeExec(value: string): string {
	const escaped = value.replace(/%/g, "%%");
	return /\s/.test(escaped) ? `"${escaped}"` : escaped;
}
