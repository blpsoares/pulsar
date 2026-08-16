import type { ServiceRecord } from "../state/registry";
import type { ServiceSpec } from "./types";

/**
 * Converte um registro em `ServiceSpec` — a descrição que os quatro backends
 * entendem.
 *
 * O detalhe que morde: `record.name` já vem COM o prefixo (`pulsar-x`, que é o
 * que `serviceName()` produz e o que o supervisor conhece), enquanto
 * `ServiceSpec.name` é só o sufixo, porque `serviceName()` reaplica o prefixo
 * sozinho. Sem tirar o prefixo aqui, toda operação a partir do registro
 * (start/stop, trocar backend, ligar boot) miraria `pulsar-pulsar-x` — um
 * serviço que não existe.
 */
export function specFromRecord(record: ServiceRecord): ServiceSpec {
	return {
		name: record.name.replace(/^pulsar-/, ""),
		mode: record.mode,
		configPath: record.config,
		workingDir: record.workingDir,
		autostart: record.boot,
	};
}
