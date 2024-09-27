import chalk from 'chalk';
import { createLogger, format, transports } from 'winston';
import { format as formatDate } from 'date-fns';
import { ptBR } from 'date-fns/locale';
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

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

const getFullDate = (): string => {
  return formatDate(new Date(), 'dd/MM/yyyy - HH:mm:ss', { locale: ptBR });
};

const logger = createLogger({
  levels: optionsLogs.levels,
  level: 'debug',
  format: combine(
    timestamp({
      format: getFullDate,
    }),
    logFormat,
  ),
  transports: [
    new transports.File({ filename: './src/logs/debug.log', level: 'debug' }),
    new transports.File({ filename: './src/logs/error.log', level: 'error' }),
    new transports.File({ filename: './src/logs/combined.log' }),
  ],
});

export const customLog = (type: OptionsCustomLogs, message: string) => {
  const prefix = `[ ${type.toUpperCase()} ]: `;
  console.log(optionsLogs[type].bold(prefix + message));
  logger.log({ level: type, message });
};

export default logger;

customLog('error', 'teste de error');
customLog('warn', 'teste de warn');
customLog('info', 'teste de info');
customLog('success', 'teste de success');
customLog('debug', 'teste de debug');
