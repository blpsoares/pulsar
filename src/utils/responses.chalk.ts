import chalk from 'chalk';

const optionsLogs = {
  success: chalk.greenBright,
  error: chalk.redBright,
  info: chalk.gray,
  warning: chalk.yellowBright,
};

export const customLog = (type: LogsOptions, message: string) => {
  console.log(optionsLogs[type].bold(message));
};
