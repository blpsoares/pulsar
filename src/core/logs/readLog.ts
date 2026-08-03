import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Leitura dos logs GRAVADOS (`./logs/*.log`, escritos pelo winston).
 *
 * Tudo aqui lê pela CAUDA, nunca o arquivo inteiro: com `LOG_MAX_SIZE` em
 * dezenas de MB, um `readFileSync` para mostrar 40 linhas na tela colocaria o
 * arquivo todo na memória da TUI. O truque é abrir o descritor, pular para o
 * fim e ler blocos para trás até juntar as N linhas pedidas.
 */

export type LogFile = { path: string; name: string; size: number };

const CHUNK = 64 * 1024;
const decoder = new TextDecoder();

/** Os `*.log` de `<dir>/logs`, maiores/mais recentes primeiro. */
export function listLogFiles(dir: string): LogFile[] {
	const logsDir = join(dir, "logs");
	if (!existsSync(logsDir)) return [];

	let entries: string[];
	try {
		entries = readdirSync(logsDir);
	} catch {
		return [];
	}

	const files: LogFile[] = [];
	for (const name of entries) {
		// winston rotaciona para debug.log1, debug.log2… — são logs também.
		if (!/\.log\d*$/i.test(name)) continue;
		const path = join(logsDir, name);
		try {
			const st = statSync(path);
			if (!st.isFile()) continue;
			files.push({ path, name, size: st.size });
		} catch {
			// arquivo sumiu no meio da rotação: ignora
		}
	}

	return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * As últimas `max` linhas inteiras do arquivo, mais o tamanho lido — esse
 * tamanho vira o offset inicial do "seguir" em `readSince`.
 */
export function tailFile(
	path: string,
	max = 500,
): { lines: string[]; size: number } {
	let fd: number | null = null;
	try {
		const size = statSync(path).size;
		if (size === 0) return { lines: [], size: 0 };

		fd = openSync(path, "r");
		let position = size;
		let newlines = 0;
		// Os blocos são guardados crus e decodificados de uma vez só no fim: um
		// caractere multibyte (acento, glifo de barra) cortado na fronteira de
		// dois blocos vira "" se cada bloco for decodificado sozinho.
		const chunks: Uint8Array[] = [];

		while (position > 0) {
			const length = Math.min(CHUNK, position);
			position -= length;
			const buf = new Uint8Array(length);
			readSync(fd, buf, 0, length, position);
			chunks.unshift(buf);
			for (const byte of buf) if (byte === 0x0a) newlines++;
			// > max: a primeira linha do bloco costuma estar cortada ao meio, e a
			// linha extra garante que ainda sobram `max` inteiras.
			if (newlines > max) break;
		}

		return { lines: splitLines(decodeAll(chunks)).slice(-max), size };
	} catch {
		return { lines: [], size: 0 };
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/**
 * Só o que o arquivo cresceu desde `offset`. Se ele ENCOLHEU (rotação do
 * winston recriou o arquivo), o offset antigo não vale mais e a leitura volta
 * pela cauda — senão o painel congelaria para sempre depois de uma rotação.
 */
export function readSince(
	path: string,
	offset: number,
): { lines: string[]; size: number } {
	let fd: number | null = null;
	try {
		const size = statSync(path).size;
		if (size < offset) return tailFile(path, 200);
		if (size === offset) return { lines: [], size };

		const length = size - offset;
		fd = openSync(path, "r");
		const buf = new Uint8Array(length);
		readSync(fd, buf, 0, length, offset);

		return { lines: splitLines(decoder.decode(buf)), size };
	} catch {
		return { lines: [], size: offset };
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/**
 * A janela visível de um log rolado, com `scroll` medido a partir do FIM
 * (0 = colado no fim, seguindo). Contar do fim, e não do começo, é o que faz o
 * "seguir" continuar funcionando enquanto o arquivo cresce: a posição 0 é
 * sempre a última linha, seja o log de 10 ou de 10 mil linhas.
 *
 * Devolve o scroll já limitado — pedir mais do que existe encosta no topo em
 * vez de rolar para o vazio.
 */
export function logWindow(
	lines: string[],
	scroll: number,
	visibleRows: number,
): { visible: string[]; scroll: number } {
	const rows = Math.max(1, visibleRows);
	const max = Math.max(0, lines.length - rows);
	const clamped = Math.max(0, Math.min(max, Math.trunc(scroll)));
	const end = lines.length - clamped;

	return {
		visible: lines.slice(Math.max(0, end - rows), end),
		scroll: clamped,
	};
}

/** Busca simples, case-insensitive. Consulta vazia devolve tudo. */
export function filterLines(lines: string[], query: string): string[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return lines;
	return lines.filter((line) => line.toLowerCase().includes(needle));
}

function splitLines(text: string): string[] {
	const lines = text.split(/\r?\n/);
	// A última linha costuma ser vazia (arquivo termina em \n).
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function decodeAll(chunks: Uint8Array[]): string {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;

	const joined = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.length;
	}

	return decoder.decode(joined);
}
