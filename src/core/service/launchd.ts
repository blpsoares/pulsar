import { homedir } from "node:os";
import { join } from "node:path";
import { argsFor, pulsarCommand } from "../run/pulsarCommand";
import { type InstallPlan, type ServiceSpec, serviceName } from "./types";

/**
 * launchd (macOS), em LaunchAgent de usuário.
 *
 * Equivalente ao que fazemos com `systemctl --user` no Linux: vive em
 * `~/Library/LaunchAgents`, não pede sudo e roda como o usuário. A diferença
 * relevante é que um LaunchAgent só existe dentro de uma sessão gráfica — com
 * `RunAtLoad` ele sobe no login, não no boot da máquina. Um Mac servidor que
 * precise subir sem login usaria um LaunchDaemon (em /Library, com root), e
 * isso está fora do que a TUI instala sozinha: seria escrever em diretório de
 * sistema como root a partir de um menu, o que não é decisão de TUI.
 *
 * Note que aqui NÃO tem `Restart=` como no systemd: o equivalente é
 * `KeepAlive`, e ele é configurado de forma diferente para daemon (sync) e
 * comando finito (migrate/ttl) — sem isso, um `migrate` que termina com
 * sucesso seria reiniciado em loop para sempre.
 */

export function agentDir(): string {
	return join(homedir(), "Library", "LaunchAgents");
}

export function agentLabel(spec: ServiceSpec): string {
	return `com.pulsar.${serviceName(spec).replace(/^pulsar-/, "")}`;
}

export function agentPath(spec: ServiceSpec): string {
	return join(agentDir(), `${agentLabel(spec)}.plist`);
}

export function buildPlist(spec: ServiceSpec): string {
	const { cmd, args } = pulsarCommand(
		argsFor(spec.mode, spec.configPath, spec.extraArgs ?? []),
	);
	const argv = [cmd, ...args];
	const label = agentLabel(spec);
	const logDir = join(spec.workingDir, "logs");
	const isSync = spec.mode === "sync";

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
${argv.map((a) => `		<string>${xmlEscape(a)}</string>`).join("\n")}
	</array>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(spec.workingDir)}</string>
	<key>RunAtLoad</key>
	<${spec.autostart ? "true" : "false"}/>
${
	isSync
		? `	<!-- daemon: sempre de volta -->
	<key>KeepAlive</key>
	<true/>`
		: `	<!-- comando finito: só reinicia se sair com erro -->
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>`
}
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>ExitTimeOut</key>
	<integer>45</integer>
	<key>StandardOutPath</key>
	<string>${xmlEscape(join(logDir, `${label}.out.log`))}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(join(logDir, `${label}.err.log`))}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PULSAR_SHUTDOWN_TIMEOUT_MS</key>
		<string>30000</string>
		<key>STATUS_INTERVAL_MS</key>
		<string>30000</string>
		<key>NO_COLOR</key>
		<string>1</string>
		<key>PATH</key>
		<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
</dict>
</plist>
`;
}

export function launchdPlan(
	spec: ServiceSpec,
	uid = process.getuid?.() ?? 501,
): InstallPlan {
	const label = agentLabel(spec);
	const path = agentPath(spec);

	return {
		backend: "launchd",
		serviceName: label,
		files: [{ path, content: buildPlist(spec) }],
		steps: [
			{
				cmd: "launchctl",
				args: ["bootout", `gui/${uid}/${label}`],
				why: "descarrega uma versão anterior, se existir",
				optional: true,
			},
			{
				cmd: "launchctl",
				args: ["bootstrap", `gui/${uid}`, path],
				why: "carrega o agent na sessão do usuário",
			},
			{
				cmd: "launchctl",
				args: ["enable", `gui/${uid}/${label}`],
				why: "garante que o agent não está desabilitado",
				optional: true,
			},
		],
		manualSteps: [],
		notes: [
			"LaunchAgent sobe no LOGIN do usuário, não no boot da máquina.",
			"Para subir sem login (Mac servidor), seria preciso um LaunchDaemon em /Library/LaunchDaemons com root — a TUI não instala isso.",
		],
	};
}

export function launchdUninstallSteps(
	label: string,
	uid = process.getuid?.() ?? 501,
) {
	return [
		{
			cmd: "launchctl",
			args: ["bootout", `gui/${uid}/${label}`],
			why: "para e descarrega o agent",
			optional: true,
		},
	];
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
