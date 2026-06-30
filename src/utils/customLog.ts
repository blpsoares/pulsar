import chalk from "chalk";
import { format as formatDate } from "date-fns";
import { ptBR } from "date-fns/locale";
import { createLogger, format, transports } from "winston";
import { multiLog } from "./progressManager";

const { combine, timestamp, printf } = format;

const optionsLogs = {
	success: chalk.greenBright,
	error: chalk.redBright,
	info: chalk.gray,
	warn: chalk.yellowBright,
	debug: chalk.blueBright,
	levels: {
		error: 0,
		info: 1,
		success: 2,
		warn: 3,
		debug: 4,
	},
};

const logFormat = printf(
	({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`,
);

const getFullDate = (): string =>
	formatDate(new Date(), "dd/MM/yyyy - HH:mm:ss", { locale: ptBR });

// Rotação dos logs em arquivo p/ NÃO lotar o disco da VM (sync roda 24/7 por
// meses; com erros a cada 5s, debug.log cresce rápido). Ao atingir LOG_MAX_SIZE,
// o winston rotaciona (debug1.log, debug2.log…) e mantém no máx LOG_MAX_FILES,
// apagando o mais antigo. Teto de disco ≈ LOG_MAX_SIZE × LOG_MAX_FILES por
// arquivo (debug e error separados). Configurável por env (setado no compose).
const toPositive = (v: string | undefined, fallback: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};
const LOG_MAX_SIZE = toPositive(process.env.LOG_MAX_SIZE, 20 * 1024 * 1024); // 20 MB
const LOG_MAX_FILES = toPositive(process.env.LOG_MAX_FILES, 5); // 5 arquivos

export const logger = createLogger({
	levels: optionsLogs.levels,
	format: combine(
		timestamp({
			format: getFullDate,
		}),
		logFormat,
	),
	transports: [
		new transports.File({
			filename: "./logs/debug.log",
			level: "debug",
			maxsize: LOG_MAX_SIZE,
			maxFiles: LOG_MAX_FILES,
			tailable: true,
		}),
		new transports.File({
			filename: "./logs/error.log",
			level: "error",
			maxsize: LOG_MAX_SIZE,
			maxFiles: LOG_MAX_FILES,
			tailable: true,
		}),
	],
});

/** Escreve apenas no terminal (não toca no winston/arquivo). */
export const terminalLog = (
	type: OptionsCustomLogs,
	message: unknown,
	breakLine?: boolean,
) => {
	const prefix = `[ ${type.toUpperCase()} ] `;
	const _breakLine = breakLine ? "\n" : "";
	multiLog(optionsLogs[type].bold(_breakLine + prefix + String(message)));
};

/**
 * Escreve apenas no ARQUIVO (winston), sem tocar no terminal/stdout. Usado quando
 * o STATUS heartbeat (não-TTY) já cobre a tela: a linha vira histórico greppável
 * em `logs/debug.log` sem poluir o `docker logs`.
 */
export const fileLog = (
	type: OptionsCustomLogs,
	message: unknown,
	error: unknown = "",
) => {
	logger.log({ level: type, message: String(message) + String(error) });
};

export const customLog = (
	type: OptionsCustomLogs,
	message: unknown,
	breakLine?: boolean,
	error: unknown = "",
) => {
	terminalLog(type, message, breakLine);
	logger.log({ level: type, message: String(message) + String(error) });
};
