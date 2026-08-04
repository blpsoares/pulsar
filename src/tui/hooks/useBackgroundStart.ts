import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { useCallback, useState } from "react";
import { loadConfigFile } from "../../core/config/loadConfig";
import { detectBackends, preferredBackend } from "../../core/service/detect";
import { BASE_COMPOSE } from "../../core/service/dockerService";
import { buildPlan, installService } from "../../core/service/manager";
import type { Backend, ServiceSpec } from "../../core/service/types";

/**
 * "Iniciar em background" em um passo, a partir da tela inicial.
 *
 * Instala e sobe o serviço com o backend nativo da máquina e autostart ligado —
 * é o que "iniciar em background" quer dizer para quem está numa VM. A tela de
 * background continua existindo para quem precisa escolher backend, ver o plano
 * completo ou remover.
 *
 * Passos privilegiados NÃO são executados aqui (nem lá): se o backend depender
 * de sudo para completar o autostart, o resultado diz isso.
 */

export type BackgroundResult = {
	ok: boolean;
	backend?: Backend;
	message: string;
};

export function useBackgroundStart(dir: string) {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<BackgroundResult | null>(null);

	const start = useCallback(
		async (file: string) => {
			setBusy(true);
			setResult(null);

			try {
				// A presença do compose PRECISA ser medida: passar `false` fixo
				// eliminava o docker da lista sempre, e numa máquina sem systemd de
				// usuário (WSL, container) e sem pm2 o atalho respondia "nenhum
				// supervisor disponível" com o docker instalado e o compose ali do lado.
				const availability = await detectBackends(
					existsSync(join(dir, BASE_COMPOSE)),
				);
				const backend = preferredBackend(availability);
				if (!backend) {
					// Sem backend, o motivo de CADA um é mais útil que a negativa seca —
					// é a diferença entre "instale o pm2" e não saber por onde começar.
					const porques = availability
						.filter((a) => a.reason)
						.map((a) => `${a.backend}: ${a.reason}`)
						.join(" · ");
					setResult({
						ok: false,
						message: `nenhum supervisor disponível — ${porques}`,
					});
					return;
				}

				const path = resolve(dir, file);
				const loaded = loadConfigFile(path);
				if (!loaded) {
					setResult({ ok: false, message: `não consegui ler ${file}` });
					return;
				}

				const spec: ServiceSpec = {
					name: basename(file).replace(/\.ya?ml$/i, ""),
					mode: loaded.form.mode,
					configPath: path,
					workingDir: dir,
					autostart: true,
				};

				const plan = buildPlan(backend, spec);
				if ("error" in plan) {
					setResult({ ok: false, backend, message: plan.error });
					return;
				}

				const installed = await installService(plan, spec);
				const pending = plan.manualSteps.length > 0;

				setResult({
					ok: installed.ok,
					backend,
					message: installed.ok
						? `${plan.serviceName} no ar via ${backend}${
								pending
									? " — falta um comando com sudo (veja em background)"
									: ""
							}`
						: `falhou: ${failureOf(installed)}`,
				});
			} finally {
				setBusy(false);
			}
		},
		[dir],
	);

	return { start, busy, result, clear: () => setResult(null) };
}

function failureOf(
	installed: Awaited<ReturnType<typeof installService>>,
): string {
	const failed = installed.results.find((r) => !r.ok);
	if (!failed) return "erro desconhecido";
	return `${failed.step.cmd} ${failed.step.args.join(" ")} — ${
		failed.output.split("\n")[0] ?? ""
	}`;
}
