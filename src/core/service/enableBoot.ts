import { userInfo } from "node:os";
import {
	type ServiceRecord,
	writeRecord as saveRecord,
} from "../state/registry";
import { dockerServiceName } from "./dockerService";
import { execStep, type StepResult } from "./execStep";
import { specFromRecord } from "./fromRecord";
import {
	type AskCallback,
	runPrivilegedStep,
	type SudoMode,
} from "./privileged";
import type { ServiceStep } from "./types";

/**
 * Ligar o boot DEPOIS, para quem instalou pulando o passo com sudo.
 *
 * É o par de `oneshot.ts` (`disableBootSteps`): lá o processo desliga o
 * autostart de um one-shot concluído; aqui o usuário religa o autostart de um
 * serviço contínuo cuja instalação registrou `boot: false` porque o passo
 * privilegiado foi recusado. Sem isto, "pular o sudo agora" seria "nunca mais
 * ter boot" — e a spec promete o contrário: a pendência vira estado visível no
 * detalhe, com atalho para resolver depois.
 *
 * Os passos são os MESMOS que o plano de instalação usaria com
 * `autostart: true` — recortados: nada de reescrever arquivo nem reiniciar o
 * serviço, que já está no ar.
 */
export function enableBootSteps(record: ServiceRecord): ServiceStep[] {
	switch (record.backend) {
		case "systemd":
			return [
				{
					cmd: "systemctl",
					args: ["--user", "enable", `${record.name}.service`],
					why: "marca a unit para subir junto com a sessão",
				},
				{
					// Costuma passar sem sudo (polkit autoriza o próprio usuário); só
					// quando falha é que o passo privilegiado abaixo entra.
					id: "linger",
					cmd: "loginctl",
					args: ["enable-linger", userInfo().username],
					why: "permite o serviço subir no boot SEM ninguém fazer login",
					optional: true,
				},
				{
					fallbackFor: "linger",
					cmd: "sudo",
					args: ["loginctl", "enable-linger", userInfo().username],
					why: "só se o passo automático de linger tiver falhado acima",
					privileged: true,
				},
			];
		case "docker":
			return [
				{
					cmd: "docker",
					// O container NÃO se chama como o registro (`pulsar-<slug>`): ele
					// nasce `pulsar-sync-<slug>` do compose. Com o nome do registro,
					// este passo falhava sempre ("no such container").
					args: [
						"update",
						"--restart=unless-stopped",
						dockerServiceName(specFromRecord(record)),
					],
					why: "faz o container voltar sozinho",
				},
				{
					cmd: "sudo",
					args: ["systemctl", "enable", "docker"],
					why: "faz o próprio Docker subir no boot (sem isso, nenhum container volta)",
					privileged: true,
				},
			];
		case "pm2":
			return [
				{
					cmd: "pm2",
					args: ["save"],
					why: "congela a lista atual para o pm2 restaurar no boot",
				},
				{
					cmd: "pm2",
					args: ["startup"],
					why: "imprime o comando com sudo que instala o pm2 no boot — rode você mesmo",
					privileged: true,
				},
			];
		case "launchd":
			// `RunAtLoad` mora DENTRO do plist: ligar exige reescrever o arquivo e
			// recarregar o agent, que é reinstalar. Devolver lista vazia deixa a tela
			// dizer isso em vez de fingir que rodou algo.
			return [];
	}
}

export type EnableBootOutcome = {
	/** nenhum passo essencial falhou */
	ok: boolean;
	results: StepResult[];
	/** passos com sudo que o usuário optou por não rodar agora */
	skipped: ServiceStep[];
	/** o backend não sabe ligar o boot sem reinstalar (launchd) */
	unsupported: boolean;
};

/**
 * Roda os passos acima com a MESMA máquina de sudo da instalação
 * (`runPrivilegedStep`): sem senha roda direto, com senha pergunta na hora
 * mostrando o comando literal, e recusar não é falha.
 *
 * O registro só carimba `boot: true` quando nada essencial falhou E nada com
 * sudo ficou pendente — o registro descreve a realidade, não a intenção (mesma
 * regra de `resolveFinalBoot` no formulário).
 */
export async function enableBoot(
	record: ServiceRecord,
	opts: {
		sudo: SudoMode;
		ask: AskCallback;
		onOutput?: (line: string) => void;
		home?: string;
		writeRecord?: (record: ServiceRecord, home?: string) => void;
	},
): Promise<EnableBootOutcome> {
	const steps = enableBootSteps(record);
	if (steps.length === 0)
		return { ok: false, results: [], skipped: [], unsupported: true };

	const results: StepResult[] = [];
	const skipped: ServiceStep[] = [];
	const byId = new Map<string, StepResult>();
	let ok = true;

	for (const step of steps) {
		// Mesma regra do `manager.ts`: o passo com sudo só roda se o automático
		// correspondente NÃO tiver resolvido sozinho — senão pediria senha à toa.
		if (step.fallbackFor && byId.get(step.fallbackFor)?.ok) continue;

		const result = step.privileged
			? await runPrivilegedStep(step, {
					cwd: record.workingDir,
					sudo: opts.sudo,
					ask: opts.ask,
					onOutput: opts.onOutput,
				})
			: await execStep(step, {
					cwd: record.workingDir,
					onOutput: opts.onOutput,
				});

		if (result === null) {
			skipped.push(step);
			continue;
		}

		results.push(result);
		if (step.id) byId.set(step.id, result);
		if (!result.ok && !step.optional) {
			ok = false;
			break;
		}
	}

	if (ok && skipped.length === 0)
		(opts.writeRecord ?? saveRecord)({ ...record, boot: true }, opts.home);

	return { ok, results, skipped, unsupported: false };
}
