import chalk from 'chalk';
import { customLog } from '../utils/custom-log';

export class YmlToJsonError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'YmlToJsonError';
    this.code = code;
  }
}

export class CustomError extends Error {
  breadcrumb: string;

  constructor(message: string, breadcrumb: string) {
    super(message);
    this.breadcrumb = breadcrumb;
  }

  logError() {
    customLog('error', `${this.message} `);
    return chalk.hex('#ff7c00').bold(this.breadcrumb);
  }
}
