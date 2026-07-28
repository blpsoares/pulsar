import { execSync } from "node:child_process";

export type Committed = { mem: number; cpus: number; names: string[] };

/**
 * Soma mem_limit e cpus já comprometidos pelos containers `pulsar-sync*`.
 *
 * Vivia dentro de `commands/compose.ts`; saiu de lá quando a TUI passou a
 * precisar do mesmo número para recomendar recursos. Duas cópias divergiriam:
 * a conta de "quanto da VM ainda está livre" tem que ser a mesma nos dois
 * caminhos, senão o compose gerado por um lado estoura o orçamento do outro.
 */
export function committedResources(): Committed {
	try {
		const names = execSync(
			'docker ps -a --filter "name=pulsar-sync" --format "{{.Names}}"',
			{ encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.filter(Boolean);

		let mem = 0;
		let cpus = 0;
		for (const n of names) {
			const raw = execSync(
				`docker inspect --format "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}" ${n}`,
				{ encoding: "utf8" },
			).trim();
			const [m, nano] = raw.split(/\s+/).map(Number);
			if (Number.isFinite(m)) mem += m;
			if (Number.isFinite(nano)) cpus += nano / 1e9;
		}
		return { mem, cpus, names };
	} catch {
		// Sem docker instalado / daemon fora do ar: nada comprometido.
		return { mem: 0, cpus: 0, names: [] };
	}
}
