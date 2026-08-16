import { isOneShot } from "../state/reconcile";
import {
	CREATED_BY_TUI,
	readRecord,
	type ServiceRecord,
	writeRecord,
} from "../state/registry";
import { dockerServiceName } from "./dockerService";
import { execStep } from "./execStep";
import { specFromRecord } from "./fromRecord";
import { agentLabel, guiTarget } from "./launchd";
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
	// `record.name` é o nome do REGISTRO (`pulsar-x`) e serve para systemd e pm2;
	// docker e launchd conhecem o serviço por outro nome. `specFromRecord` tira o
	// prefixo, e cada backend reaplica o SEU — sem isso o alvo era
	// `com.pulsar.pulsar-x` / um container inexistente, o comando falhava e o
	// registro carimbava `boot: false` mentindo: o agent continuava subindo.
	const spec = specFromRecord(record);

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
				{
					cmd: "docker",
					args: ["update", "--restart=no", dockerServiceName(spec)],
					why,
				},
			];
		case "pm2":
			return [
				{ cmd: "pm2", args: ["delete", record.name], why },
				{ cmd: "pm2", args: ["save"], why },
			];
		case "launchd":
			return [
				{
					cmd: "launchctl",
					args: ["bootout", guiTarget(agentLabel(spec))],
					why,
				},
			];
	}
}

export async function disableBootAfterSuccess(
	name: string,
	status: "ok" | "error",
	home?: string,
): Promise<void> {
	const record = readRecord(name, home);
	if (!record || !shouldDisableBoot(record, status)) return;

	let ok = true;
	for (const step of disableBootSteps(record)) {
		const result = await execStep(step, { cwd: record.workingDir });
		if (!result.ok) ok = false;
	}

	// `boot: false` só quando o supervisor CONFIRMOU. Carimbar mesmo com o
	// comando falhando deixava o registro mentindo — a tela dizia "não sobe no
	// boot" e o serviço subia assim mesmo, re-executando a migração inteira.
	// Sem carimbo, a próxima execução tenta desligar de novo.
	if (ok) writeRecord({ ...record, boot: false }, home);
}
