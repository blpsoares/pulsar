import { useEffect, useState } from "react";

/**
 * Devolve o valor só depois que ele para de mudar por `delayMs`.
 *
 * Existe por causa de um custo assimétrico: mover o cursor numa lista é
 * barato, mas o que fica DO OUTRO LADO da seleção às vezes é caríssimo —
 * spawnar um `journalctl -f`, abrir um arquivo, matar o processo anterior.
 * Descer dez itens com a seta faria isso dez vezes, e nove seriam jogadas fora
 * antes de renderizar qualquer coisa.
 *
 * A seleção visível continua imediata (quem desenha a lista usa o valor cru);
 * só o efeito caro espera a mão parar.
 */
export function useSettled<T>(value: T, delayMs: number): T {
	const [settled, setSettled] = useState(value);

	useEffect(() => {
		// O primeiro valor não espera: abrir a tela já mostra a fonte inicial.
		if (settled === value) return;
		const timer = setTimeout(() => setSettled(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs, settled]);

	return settled;
}
