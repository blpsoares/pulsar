import { resolve } from "node:path";

/**
 * Como chamar o pulsar de novo, a partir de dentro dele mesmo.
 *
 * Existem dois jeitos de o pulsar estar rodando, e o comando muda em cada um:
 *
 * - BINÁRIO compilado (`bun build --compile`): o executável é auto-contido e
 *   `process.execPath` já é ele. Basta passar os argumentos.
 * - CÓDIGO (`bun src/cli.ts`): `process.execPath` é o binário do **bun**, e o
 *   script precisa ir como primeiro argumento.
 *
 * Errar isso é sutil e caro: o serviço do systemd/launchd guarda a linha de
 * comando gerada aqui e só falha no boot seguinte, quando ninguém está olhando.
 * Por isso o modo é detectado, não presumido.
 */

export type Command = { cmd: string; args: string[] };

/**
 * `Bun.main` aponta para o sistema de arquivos virtual (`/$bunfs/...`) quando
 * o processo é um executável compilado — é o sinal mais confiável de que
 * estamos no binário e não no código-fonte.
 */
export function isCompiledBinary(): boolean {
	try {
		return typeof Bun !== "undefined" && Bun.main.startsWith("/$bunfs");
	} catch {
		return false;
	}
}

/** Caminho do `cli.ts`, usado só no modo código-fonte. */
export function cliScriptPath(): string {
	return resolve(import.meta.dir, "../../cli.ts");
}

export function pulsarCommand(args: string[]): Command {
	if (isCompiledBinary()) return { cmd: process.execPath, args };
	return { cmd: process.execPath, args: [cliScriptPath(), ...args] };
}

/** A mesma coisa em uma linha, para gravar em unit file do systemd/launchd. */
export function pulsarCommandLine(args: string[]): string {
	const { cmd, args: full } = pulsarCommand(args);
	return [cmd, ...full].map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
	return /[\s"'$`\\]/.test(arg)
		? `"${arg.replace(/(["\\$`])/g, "\\$1")}"`
		: arg;
}

export type RunMode = "sync" | "migrate" | "ttl";

/** Argumentos do comando a partir do modo + caminho do yml. */
export function argsFor(
	mode: RunMode,
	configPath: string,
	extra: string[] = [],
): string[] {
	return [mode, configPath, ...extra];
}
