import chalk from "chalk";
import { MongoError, MongoParseError } from "mongodb";
import { ZodError } from "zod";
import { customLog, logger } from "../utils/customLog";

class YmlToJsonError extends Error {
	code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "YmlToJsonError";
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
		customLog("error", `${this.message}`);
		logger.error(this.breadcrumb);
		return chalk.hex("#ff7c00").bold(this.breadcrumb);
	}
}

export const errorHandler = (
	err: unknown,
	breadcrumb: string = "NO:BREADCRUMB",
) => {
	let errorMessage = "";

	if (err instanceof MongoParseError) {
		errorMessage = `Mongo Parse Error: ${err.message}`;
	} else if (err instanceof MongoError) {
		errorMessage = `Mongo Error: ${err.message}`;
	} else if (err instanceof YmlToJsonError) {
		errorMessage = `Yml To Json Error: ${err.message}`;
	} else if (err instanceof ZodError) {
		errorMessage = `Zod Error ${err}`;
	} else if (err instanceof Error) {
		errorMessage = `Error: ${err.message}`;
	} else {
		errorMessage = `Unknown Error: ${String(err)}`;
	}

	throw new CustomError(errorMessage, breadcrumb).logError();
};
