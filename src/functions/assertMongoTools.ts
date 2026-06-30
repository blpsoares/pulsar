import { errorHandler } from "../errors/errorHandler";
import { t } from "../utils/i18n";

/**
 * Preflight do `migrate`: o fluxo de dump/restore faz shell-out pros binários
 * `mongodump` e `mongorestore` (mongodb-database-tools), que NÃO vêm com o
 * pulsar nem com o Bun. Sem eles, cada collection falhava com um genérico
 * "command not found" só no arquivo de log, e a app insistia 3x antes de
 * morrer com "Failed after N attempts" — sem dizer a causa. Aqui a gente
 * verifica o PATH ANTES de conectar e falha em 0ms com instrução clara.
 */
export const assertMongoTools = () => {
	const required = ["mongodump", "mongorestore"];
	const missing = required.filter((bin) => Bun.which(bin) === null);

	if (missing.length > 0) {
		throw errorHandler(
			t("migrate.tools_missing", { missing: missing.join(", ") }),
			"MIGRATE:TOOLS:MISSING",
		);
	}
};
