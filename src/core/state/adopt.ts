import type { RunMode } from "../run/pulsarCommand";
import type { ServiceRecord } from "./registry";

/**
 * Reconstrói o registro a partir do que o supervisor já guarda.
 *
 * Serviço criado por uma versão anterior da TUI, ou à mão, não tem registro —
 * e sem isto viraria uma linha "pulsar-alguma-coisa" sem modo, sem yml e sem
 * ações úteis. Mas a informação existe: a unit do systemd guarda o ExecStart
 * inteiro, o container guarda o command, o pm2 guarda os args. Ler de lá custa
 * um comando e evita transformar serviço legítimo em lixo órfão.
 */

const MODES: RunMode[] = ["sync", "migrate", "ttl"];

/**
 * Acha o par (modo, yml) numa linha de comando, seja ela do binário compilado
 * (`pulsar sync x.yml`) ou do modo código-fonte (`bun src/cli.ts sync x.yml`).
 * Procurar pelo modo, e não por posição, é o que faz os dois casos caírem no
 * mesmo código.
 */
export function parseExecStart(
	line: string,
): { mode: RunMode; config: string } | null {
	const parts = line.trim().split(/\s+/);

	for (let i = 0; i < parts.length - 1; i++) {
		const mode = parts[i] as RunMode;
		const next = parts[i + 1];
		if (!MODES.includes(mode) || !next || next.startsWith("-")) continue;
		return { mode, config: next };
	}

	return null;
}

export function adoptFromSystemd(
	name: string,
	showOutput: string,
): ServiceRecord | null {
	const props = new Map<string, string>();
	for (const line of showOutput.split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) props.set(line.slice(0, i), line.slice(i + 1).trim());
	}

	// O ExecStart do `show` vem embrulhado: { path=… ; argv[]=… ; … }
	const raw = props.get("ExecStart") ?? "";
	const argv = /argv\[\]=([^;}]+)/.exec(raw)?.[1] ?? raw;
	const parsed = parseExecStart(argv);
	if (!parsed) return null;

	return {
		name,
		mode: parsed.mode,
		config: parsed.config,
		workingDir: props.get("WorkingDirectory") || ".",
		backend: "systemd",
		boot: props.get("UnitFileState") === "enabled",
		createdBy: "adotado",
		lastRun: null,
	};
}

export function adoptFromDocker(
	name: string,
	command: string,
	workingDir: string,
): ServiceRecord | null {
	const parsed = parseExecStart(command);
	if (!parsed) return null;

	return {
		name,
		mode: parsed.mode,
		config: parsed.config,
		workingDir,
		backend: "docker",
		// A política de restart é lida pelo discover; aqui só o que a linha diz.
		boot: false,
		createdBy: "adotado",
		lastRun: null,
	};
}
