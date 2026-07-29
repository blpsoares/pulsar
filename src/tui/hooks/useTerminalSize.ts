import { useEffect, useState } from "react";

/**
 * Dimensões do terminal, com reação a resize.
 *
 * O layout de cockpit precisa disso: os painéis têm largura calculada (sidebar
 * fixa + centro elástico + painel direito fixo) e altura calculada (total menos
 * cabeçalho e rodapé). Sem reagir ao resize, esticar a janela deixaria a
 * interface desenhada no tamanho antigo até a próxima tecla.
 *
 * O piso de 60x20 evita o pior caso: numa janela minúscula as larguras viram
 * negativas e o yoga desenha lixo. Abaixo disso a TUI avisa em vez de tentar.
 */

export const MIN_COLUMNS = 60;
export const MIN_ROWS = 20;

export type TerminalSize = {
	columns: number;
	rows: number;
	tooSmall: boolean;
};

export function useTerminalSize(): TerminalSize {
	const [size, setSize] = useState(() => read());

	useEffect(() => {
		const onResize = () => setSize(read());
		process.stdout.on("resize", onResize);
		return () => {
			process.stdout.off("resize", onResize);
		};
	}, []);

	return {
		...size,
		tooSmall: size.columns < MIN_COLUMNS || size.rows < MIN_ROWS,
	};
}

function read(): { columns: number; rows: number } {
	return {
		columns: process.stdout.columns ?? 80,
		rows: process.stdout.rows ?? 24,
	};
}
