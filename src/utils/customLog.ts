import chalk from "chalk";
import { createLogger, format, transports } from "winston";
import { format as formatDate } from "date-fns";
import { ptBR } from "date-fns/locale";
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

export const logger = createLogger({
	levels: optionsLogs.levels,
	format: combine(
		timestamp({
			format: getFullDate,
		}),
		logFormat,
	),
	transports: [
		new transports.File({ filename: "./logs/debug.log", level: "debug" }),
		new transports.File({ filename: "./logs/error.log", level: "error" }),
	],
});

/** Escreve apenas no terminal (não toca no winston/arquivo). */
export const terminalLog = (
	type: OptionsCustomLogs,
	message: any,
	breakLine?: boolean,
) => {
	const prefix = `[ ${type.toUpperCase()} ] `;
	const _breakLine = breakLine ? "\n" : "";
	multiLog(optionsLogs[type].bold(_breakLine + prefix + message));
};

export const customLog = (
	type: OptionsCustomLogs,
	message: any,
	breakLine?: boolean,
	error: any = "",
) => {
	terminalLog(type, message, breakLine);
	logger.log({ level: type, message: message + error });
};
