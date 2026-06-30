import fs from "fs";
import yaml from "js-yaml";
import type { ZodType } from "zod";
import { ZodError } from "zod";
import { errorHandler } from "../errors/errorHandler";
import { t } from "./i18n";

const parseYml = <T>(ymlPath: string, schema: ZodType<T>): T => {
	if (!fs.existsSync(ymlPath)) {
		throw errorHandler(new Error(t("yml.error.not_found", { path: ymlPath })));
	}

	const yml = fs.readFileSync(ymlPath, "utf-8");
	const rawData = yaml.load(yml);

	if (!rawData) {
		throw errorHandler(new Error(t("yml.error.empty")));
	}

	try {
		return schema.parse(rawData);
	} catch (err) {
		if (err instanceof ZodError) {
			throw errorHandler(err, "PARSE:YML:ZOD");
		}
		throw err;
	}
};

export default parseYml;
