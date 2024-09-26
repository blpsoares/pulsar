import chalk from 'chalk';
import { createLogger, format, transports, addColors } from 'winston';
const { combine, timestamp, printf, colorize } = format;

const customLevels = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    success: 3,
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'blue',
    success: 'green',
  },
};
const optionsLogs = {
  success: chalk.greenBright,
  error: chalk.redBright,
  info: chalk.gray,
  warn: chalk.yellowBright,
};

addColors(customLevels.colors);

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

const logger = createLogger({
  levels: customLevels.levels,
  level: 'success',
  format: combine(timestamp({ format: 'DD-MM HH:mm:ss' }), logFormat),
  transports: [
    new transports.File({ filename: './src/logs/error.log', level: 'error' }),
    new transports.File({ filename: './src/logs/combined.log' }),
  ],
});

export const customLog = (type: OptionsCustomLogs, message: string) => {
  console.log('\n' + optionsLogs[type].bold(message));
  logger.log({ level: type, message });
};

export default logger;
