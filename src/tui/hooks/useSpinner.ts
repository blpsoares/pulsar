import { useEffect, useState } from "react";

/**
 * Contador de frames para o spinner.
 *
 * `active: false` congela o timer em vez de deixá-lo girando — um `setInterval`
 * vivo mantém o processo acordado e faz o ink redesenhar a tela 12x/s sem
 * necessidade (visível como flicker e como CPU num terminal remoto).
 */
export function useSpinner(active: boolean, intervalMs = 80): number {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setFrame((f) => f + 1), intervalMs);
		return () => clearInterval(id);
	}, [active, intervalMs]);

	return frame;
}
