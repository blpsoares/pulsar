import { isOneShot } from "../state/reconcile";
import {
	CREATED_BY_TUI,
	readRecord,
	type ServiceRecord,
	writeRecord,
} from "../state/registry";
import { execStep } from "./execStep";
import { agentLabel } from "./launchd";
import type { ServiceStep } from "./types";

/**
 * `migrate` e `ttl` terminam — e um serviço que terminou não deve subir de novo
 * a cada reinício da máquina, re-executando a migração inteira.
 *
 * Quem desliga é o próprio processo, ao concluir: a TUI pode estar fechada, e
 * frequentemente está. Duas travas impedem que isso vire surpresa: só mexe em
 * serviço que o PULSAR criou (`createdBy`), e só no SUCESSO — desligar no erro
 * tiraria a retentativa sem ninguém perceber.
 */

export function shouldDisableBoot(
	record: ServiceRecord,
	status: "ok" | "error",
): boolean {
	if (status !== "ok") return false;
	if (!record.boot) return false;
	if (!isOneShot(record.mode)) return false;
	return record.createdBy === CREATED_BY_TUI;
}

export function disableBootSteps(record: ServiceRecord): ServiceStep[] {
	const why = "one-shot concluído: não subir mais no boot";

	switch (record.backend) {
		case "systemd":
			return [
				{
					cmd: "systemctl",
					args: ["--user", "disable", `${record.name}.service`],
					why,
				},
			];
		case "docker":
			return [
				{ cmd: "docker", args: ["update", "--restart=no", record.name], why },
			];
		case "pm2":
			return [
				{ cmd: "pm2", args: ["delete", record.name], why },
				{ cmd: "pm2", args: ["save"], why },
			];
		case "launchd": {
			// agentLabel espera um ServiceSpec completo (é a mesma conta usada pra
			// montar o plist original); o registro guarda os mesmos campos com
			// outros nomes, então a conversão é só de rótulo.
			const label = agentLabel({
				name: record.name,
				mode: record.mode,
				configPath: record.config,
				workingDir: record.workingDir,
				autostart: record.boot,
			});
			return [
				{
					cmd: "launchctl",
					args: ["bootout", `gui/${process.getuid?.() ?? 501}/${label}`],
					why,
				},
			];
		}
	}
}

export async function disableBootAfterSuccess(
	name: string,
	status: "ok" | "error",
	home?: string,
): Promise<void> {
	const record = readRecord(name, home);
	if (!record || !shouldDisableBoot(record, status)) return;

	for (const step of disableBootSteps(record))
		await execStep(step, { cwd: record.workingDir });

	writeRecord({ ...record, boot: false }, home);
}
