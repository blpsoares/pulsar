import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import {
	migrateYmlSchema,
	syncYmlSchema,
	ttlYmlSchema,
} from "../../types/parseYml";
import type { TuiMode } from "../inspect/summary";
import type { PulsarConfig } from "./buildConfig";

/**
 * Serializa e grava o yml.
 *
 * Duas garantias que importam:
 *
 * 1. VALIDA ANTES DE GRAVAR, com o MESMO schema Zod que o `parseYml` usa ao
 *    rodar o comando. Assim a TUI é incapaz de produzir um arquivo que o
 *    pulsar depois recusaria — o erro aparece na tela, não três telas adiante
 *    quando o sync não sobe.
 * 2. Grava de forma ATÔMICA (arquivo temporário + rename). Um Ctrl+C no meio
 *    da escrita não deixa um yml truncado no lugar de uma config que
 *    funcionava.
 */

export type WriteResult =
	| { ok: true; path: string }
	| { ok: false; errors: string[] };

const schemas = {
	sync: syncYmlSchema,
	migrate: migrateYmlSchema,
	ttl: ttlYmlSchema,
} as const;

export function validateConfig(mode: TuiMode, config: PulsarConfig): string[] {
	const result = schemas[mode].safeParse(config);
	if (result.success) return [];
	return result.error.issues.map(
		(i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`,
	);
}

export function toYaml(config: PulsarConfig): string {
	return yaml.dump(config, {
		indent: 2,
		lineWidth: 120,
		// Sem referências (&ref/*ref): duas collections com o mesmo filtro viram
		// uma âncora e o yml fica ilegível pra quem for editar na mão depois.
		noRefs: true,
	});
}

export function writeConfigFile(
	path: string,
	mode: TuiMode,
	config: PulsarConfig,
): WriteResult {
	const errors = validateConfig(mode, config);
	if (errors.length > 0) return { ok: false, errors };

	const target = resolve(path);
	const tmp = join(dirname(target), `.${Date.now()}.pulsar.tmp`);

	try {
		writeFileSync(tmp, toYaml(config), "utf8");
		renameSync(tmp, target);
		return { ok: true, path: target };
	} catch (err) {
		return {
			ok: false,
			errors: [err instanceof Error ? err.message : String(err)],
		};
	}
}

/**
 * Sugere um nome de arquivo livre. A TUI ainda confirma antes de sobrescrever,
 * mas propor um nome já ocupado convida ao acidente.
 */
export function suggestFileName(
	mode: TuiMode,
	destDb: string,
	dir = process.cwd(),
): string {
	const slug = (destDb || mode).replace(/[^\w.-]+/g, "-").toLowerCase();
	const base = `${slug}-${mode}`;

	if (!existsSync(join(dir, `${base}.yml`))) return `${base}.yml`;
	for (let i = 2; i < 100; i++) {
		if (!existsSync(join(dir, `${base}-${i}.yml`))) return `${base}-${i}.yml`;
	}
	return `${base}-${Date.now()}.yml`;
}
