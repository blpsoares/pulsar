const MiB = 1024 * 1024;

export type ResourceRec = {
	memLimitMiB: number;
	memReservMiB: number;
	cpus: number;
};

/**
 * Recomenda recursos pra UMA nova instância com base no que JÁ está em uso na
 * máquina: parte do orçamento da VM (~65% da RAM, ~1 núcleo livre) e SUBTRAI o
 * que as instâncias existentes já comprometeram (mem_limit / cpus delas). Assim
 * o somatório de todas cabe no orçamento — não oversubscreve.
 *
 * @param totalRamBytes  RAM total da VM (os.totalmem()).
 * @param cores          núcleos de CPU (os.cpus().length).
 * @param committedMemBytes  soma dos mem_limit das instâncias existentes (bytes).
 * @param committedCpus      soma dos cpus das instâncias existentes (núcleos).
 */
export function recommendResources(
	totalRamBytes: number,
	cores: number,
	committedMemBytes = 0,
	committedCpus = 0,
): ResourceRec {
	const budgetMiB = Math.floor((totalRamBytes * 0.65) / MiB);
	const committedMiB = Math.floor(Math.max(0, committedMemBytes) / MiB);
	const memLimitMiB = Math.max(256, budgetMiB - committedMiB);
	const memReservMiB = Math.floor(memLimitMiB * 0.5);

	// deixa ~1 núcleo livre (meio em máquinas de 1-2) e tira o que já foi comprometido.
	const cpuBudget = cores <= 2 ? Math.max(1, cores - 0.5) : cores - 1;
	const free = cpuBudget - Math.max(0, committedCpus);
	const cpus = Math.max(0.25, Math.round(free * 100) / 100);

	return { memLimitMiB, memReservMiB, cpus };
}
