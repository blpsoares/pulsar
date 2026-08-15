import { disableBootAfterSuccess } from "../service/oneshot";
import { type RunStats, readRecord, writeRecord } from "./registry";

/**
 * O resultado da última execução, gravado pelo PRÓPRIO processo do pulsar.
 *
 * Não dá para a TUI observar isso de fora: o serviço roda no boot, sem
 * ninguém olhando, e termina horas depois. Quem sabe quantos documentos foram
 * copiados é quem os copiou — os números já existem (são os mesmos do painel
 * final), só estavam virando texto e se perdendo.
 *
 * Execução avulsa (`pulsar sync x.yml` no terminal) não tem
 * `PULSAR_SERVICE_NAME` e não grava nada: não é um serviço e não deve inventar
 * um registro.
 */

export function serviceNameFromEnv(): string | null {
	return process.env.PULSAR_SERVICE_NAME || null;
}

export function beginRun(name: string, home?: string): void {
	const record = readRecord(name, home);
	if (!record) return;

	writeRecord(
		{
			...record,
			lastRun: {
				startedAt: new Date().toISOString(),
				endedAt: null,
				status: "running",
				exitCode: null,
				stats: {},
				error: null,
			},
		},
		home,
	);
}

// SGR (Select Graphic Rendition) — o formato que o chalk usa pra colorir
// (`ESC[<códigos>m`). `errorHandler` (src/errors/errorHandler.ts) loga a
// causa real e relança só um breadcrumb colorido com chalk; sem tirar isso,
// o registro grava lixo tipo "\x1b[38;2;255;124;0mCONN:MONGO:CLIENT\x1b[39m".
// biome-ignore lint/suspicious/noControlCharactersInRegex: precisa casar o byte de escape ANSI pra removê-lo.
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/**
 * Desembrulha a mensagem gravável de um erro pego no catch de um comando.
 *
 * `errorHandler` já loga a causa real (`customLog`/`logger.error`) e relança
 * só o breadcrumb colorido — o objeto de erro original não sobrevive até
 * aqui. Por isso: quando `error` chega como STRING, é esse breadcrumb —
 * tiramos os códigos ANSI e usamos como está (é a melhor informação que
 * sobrou). Quando `error` é um `Error` de verdade (não passou por nenhum
 * `errorHandler` no caminho), a causa real está em `.message` — essa é
 * preferível, e é o formato que o brief pedia (`"ECONNREFUSED
 * 127.0.0.1:27017"`).
 */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error.replace(ANSI_SGR, "");
	return String(error);
}

/**
 * `true` quando `error` já passou por um `errorHandler` — que loga e relança
 * só uma string (o breadcrumb colorido), nunca o `Error`/`CustomError`
 * original. Comandos cujo próprio `catch` também chama `errorHandler` (pra
 * decorar com o breadcrumb do comando, ex.: "WATCH:COLL") precisam checar
 * isso ANTES: chamar `errorHandler` de novo em cima de um erro já tratado
 * sobrescreve o breadcrumb original (ex.: "CONN:MONGO:CLIENT") pelo genérico
 * do comando e duplica a linha de log — mascarando a causa real num daemon
 * que já roda sem ninguém olhando.
 */
export function isAlreadyHandled(error: unknown): boolean {
	return typeof error === "string";
}

export function finishRun(
	name: string,
	outcome: {
		status: "ok" | "error";
		exitCode: number | null;
		stats: RunStats;
		error?: string | null;
	},
	home?: string,
): void {
	const record = readRecord(name, home);
	if (!record) return;

	writeRecord(
		{
			...record,
			lastRun: {
				// Preserva o início marcado pelo beginRun; sem ele, a duração seria 0.
				startedAt: record.lastRun?.startedAt ?? new Date().toISOString(),
				endedAt: new Date().toISOString(),
				status: outcome.status,
				exitCode: outcome.exitCode,
				stats: outcome.stats,
				error: outcome.error ?? null,
			},
		},
		home,
	);

	// Fora do caminho síncrono: o comando já terminou e não deve esperar o
	// supervisor responder para poder sair.
	void disableBootAfterSuccess(name, outcome.status, home).catch(() => {});
}
