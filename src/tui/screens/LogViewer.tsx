import { basename } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard, describeCopy } from "../../core/clipboard";
import { listLogFiles, readSince, tailFile } from "../../core/logs/readLog";
import { tailCommand } from "../../core/logs/tailCommand";
import type { Backend } from "../../core/service/types";
import { useProcess } from "../hooks/useProcess";
import { hintsFor } from "../keys";
import { useClickable, useMouse } from "../mouse/MouseProvider";
import { isMouseInput } from "../mouse/parse";
import { glyph, theme } from "../theme";

/**
 * Log em TELA CHEIA — o pedido direto do usuário: "bota alguma tecla de
 * atalho pra expandir a tela inteira e conseguir ver os logs, assim eu
 * consigo scrollar, subir descer copiar etc". Por isso este componente NÃO
 * usa `Shell` (cabeçalho/sidebar/chrome) nem `Overlay` (moldura+margem) — é
 * conteúdo mais uma linha de teclas, e mais nada disputando altura.
 */

const POLL_MS = 1000;
const FILE_TAIL_LINES = 500;
const MAX_LINES = 2000;

export type LogViewerSource =
	| { kind: "file"; dir: string; file?: string }
	| {
			kind: "live";
			dir: string;
			backend: Backend;
			name: string;
			label: string;
	  };

/**
 * Qual fatia do buffer aparece na tela.
 *
 * `offset` conta linhas ACIMA do fim, não do começo: um log ao vivo cresce, e
 * ancorar no começo faria a janela deslizar sozinha enquanto a pessoa lê.
 */
export function scrollWindow(
	total: number,
	height: number,
	offset: number,
): { start: number; end: number } {
	const end = Math.max(Math.min(total, height), total - offset);
	return { start: Math.max(0, end - height), end };
}

export function LogViewer({
	source,
	columns,
	rows,
	onClose,
	onCycleSource,
	onHelp,
	enabled = true,
}: {
	source: LogViewerSource;
	columns: number;
	rows: number;
	onClose: () => void;
	/**
	 * `s` troca a fonte (ao vivo ↔ cada arquivo de ./logs). Quem guarda a lista
	 * é o `App`, que remonta este componente por `key` — trocar de fonte zera
	 * rolagem e busca de propósito: são de outro texto.
	 */
	onCycleSource?: () => void;
	/** `?` é tratado aqui porque durante a busca (`/`) as teclas são texto */
	onHelp?: () => void;
	/** false quando a ajuda está por cima */
	enabled?: boolean;
}) {
	const { lines, title, live } = useLogSource(source);

	const [offset, setOffset] = useState(0);
	const [follow, setFollow] = useState(true);
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState("");
	const [matchPos, setMatchPos] = useState(-1);
	const [copyMsg, setCopyMsg] = useState<string | null>(null);
	const mouse = useMouse();

	// Reserva: título (1) + rodapé de teclas (1) [+ barra de busca (1)].
	const reserved = 2 + (searching ? 1 : 0);
	const bodyHeight = Math.max(1, rows - reserved);

	// `follow` TRAVA o offset em 0 — é o "auto-scroll": mesmo que `offset`
	// guarde uma posição antiga (de quando a pessoa pausou), enquanto `follow`
	// estiver ligado a janela fica sempre colada no fim.
	const effectiveOffset = follow ? 0 : offset;
	const window = scrollWindow(lines.length, bodyHeight, effectiveOffset);
	const visibleLines = lines.slice(window.start, window.end);
	// A linha em foco é sempre a última visível — depois de um salto de busca
	// (`n`/`N`) é exatamente a ocorrência encontrada, porque o salto posiciona
	// a janela com o match no fim.
	const focusedLine = lines[window.end - 1] ?? "";

	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return [];
		const found: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].toLowerCase().includes(needle)) found.push(i);
		}
		return found;
	}, [lines, query]);

	function jumpTo(lineIndex: number) {
		setFollow(false);
		// Coloca a linha encontrada como a ÚLTIMA da janela (o mesmo cálculo que
		// `scrollWindow` já sabe clampar, então funciona perto do topo/fim sem
		// duplicar lógica de limite aqui).
		setOffset(Math.max(0, lines.length - lineIndex - 1));
	}

	function jumpToMatch(direction: 1 | -1) {
		if (matches.length === 0) return;
		const next =
			matchPos < 0
				? nearestMatch(matches, window.end - 1, direction)
				: (matchPos + direction + matches.length) % matches.length;
		setMatchPos(next);
		jumpTo(matches[next]);
	}

	function submitSearch() {
		setSearching(false);
		if (matches.length === 0) return;
		const pos = nearestMatch(matches, window.end - 1, 1);
		setMatchPos(pos);
		jumpTo(matches[pos]);
	}

	function flashCopy(text: string, via: string) {
		setCopyMsg(
			via === "nenhum"
				? "cópia falhou (sem OSC 52 nem utilitário)"
				: `copiado: ${describeCopy(text)}`,
		);
	}

	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;

			if (searching) {
				if (key.return) {
					submitSearch();
					return;
				}
				if (key.escape) {
					setSearching(false);
					return;
				}
				if (key.backspace || key.delete) {
					setQuery((q) => q.slice(0, -1));
					return;
				}
				if (input && !key.ctrl && !key.meta && !key.tab)
					setQuery((q) => q + input);
				return;
			}

			if (key.escape) {
				onClose();
				return;
			}
			if (key.upArrow) {
				setFollow(false);
				setOffset((o) => o + 1);
				return;
			}
			if (key.downArrow) {
				setOffset((o) => Math.max(0, o - 1));
				return;
			}
			if (key.pageUp) {
				setFollow(false);
				setOffset((o) => o + bodyHeight);
				return;
			}
			if (key.pageDown) {
				setOffset((o) => Math.max(0, o - bodyHeight));
				return;
			}
			if (input === "g") {
				// topo: mostra o começo do log, para de seguir.
				setFollow(false);
				setOffset(lines.length);
				return;
			}
			if (input === "G") {
				// fim: "volta a acompanhar" — o único gesto que RELIGA o follow.
				setOffset(0);
				setFollow(true);
				return;
			}
			if (input === "f") {
				setFollow((f) => !f);
				return;
			}
			if (input === "/") {
				setSearching(true);
				return;
			}
			if (input === "n") {
				jumpToMatch(1);
				return;
			}
			if (input === "N") {
				jumpToMatch(-1);
				return;
			}
			if (key.ctrl && input === "c") {
				const result = copyToClipboard(focusedLine);
				flashCopy(focusedLine, result.via);
				return;
			}
			if (input === "Y") {
				const text = visibleLines.join("\n");
				const result = copyToClipboard(text);
				flashCopy(text, result.via);
				return;
			}
			if (input === "m") {
				mouse.toggle();
				return;
			}
			if (input === "s") {
				onCycleSource?.();
				return;
			}
			if (input === "?") {
				onHelp?.();
				return;
			}
		},
		{ isActive: enabled },
	);

	// A mensagem de cópia é feedback passageiro — sem isso ela ficaria colada
	// na tela cobrindo o rodapé de teclas depois de qualquer ctrl+c.
	useEffect(() => {
		if (!copyMsg) return;
		const id = setTimeout(() => setCopyMsg(null), 2000);
		return () => clearTimeout(id);
	}, [copyMsg]);

	const wheelRef = useClickable({
		onWheel: (direction) => {
			// roda para cima (-1) = voltar no tempo = afastar do fim, igual à seta.
			if (direction < 0) setFollow(false);
			setOffset((o) => Math.max(0, o - direction * 3));
		},
	});

	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Text color={theme.accent} bold wrap="truncate-end">
				{glyph.cursor} {title}
				{query
					? ` · busca: "${query}"${matches.length ? ` (${matches.length})` : " (sem ocorrências)"}`
					: ""}
				{" · "}
				<Text color={follow ? theme.ok : theme.warn}>
					{follow ? "seguindo" : `pausado · ${effectiveOffset} acima do fim`}
				</Text>
				{!mouse.enabled ? <Text color={theme.muted}> · mouse off</Text> : null}
				{live && !live.running ? (
					<Text color={theme.warn}> · seguidor parado</Text>
				) : null}
			</Text>

			<Box flexDirection="column" flexGrow={1} overflow="hidden" ref={wheelRef}>
				{visibleLines.length === 0 ? (
					<Text color={theme.muted}>
						{lines.length === 0 ? "aguardando linhas…" : "nada visível"}
					</Text>
				) : (
					visibleLines.map((line, i) => (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: janela de log é posicional
							key={i}
							backgroundColor={
								window.start + i === window.end - 1 ? theme.border : undefined
							}
							color={
								matches.includes(window.start + i)
									? theme.accent
									: colorFor(line)
							}
							wrap="truncate-end"
						>
							{line || " "}
						</Text>
					))
				)}
			</Box>

			{searching ? (
				<Text color={theme.accent}>
					buscar: {query}
					<Text inverse> </Text>
				</Text>
			) : null}

			<Text color={theme.muted}>
				{copyMsg ??
					hintsFor("logs")
						.map((h) => `${h.keys} ${h.label}`)
						.join("  ·  ")}
			</Text>
		</Box>
	);
}

/** Menor `level` reconhecido na linha, para colorir sem depender de JSON estruturado. */
function colorFor(line: string): string | undefined {
	if (/\[\s*ERROR\s*\]|✖|error|falh|fail/i.test(line)) return theme.error;
	if (/\[\s*WARN\s*\]|⚠|warn|aviso/i.test(line)) return theme.warn;
	if (/\[\s*DEBUG\s*\]|debug/i.test(line)) return theme.muted;
	return undefined;
}

/** O match mais próximo de `from`, na direção pedida — cíclico. */
function nearestMatch(
	matches: number[],
	from: number,
	direction: 1 | -1,
): number {
	if (direction === 1) {
		const i = matches.findIndex((m) => m > from);
		return i >= 0 ? i : 0;
	}
	for (let i = matches.length - 1; i >= 0; i--) {
		if (matches[i] < from) return i;
	}
	return matches.length - 1;
}

/**
 * Lê a fonte (arquivo gravado ou seguidor ao vivo do supervisor) e devolve o
 * buffer de linhas cru — a janela/rolagem/busca são todas por cima disso,
 * aqui.
 *
 * As DUAS famílias de hook (arquivo + processo) são chamadas SEMPRE, nesta
 * ordem, todo render — nunca dentro de um `if (source.kind === ...)`. As
 * regras do React proíbem chamar hooks condicionalmente; o que varia por
 * `source.kind` é só QUAL resultado o componente aproveita no final.
 */
function useLogSource(source: LogViewerSource): {
	lines: string[];
	title: string;
	live: { running: boolean } | null;
} {
	const isFile = source.kind === "file";
	const dir = source.dir;
	const explicitFile = source.kind === "file" ? source.file : undefined;
	// Memoizado por CAMPOS primitivos, não pelo objeto `source`: se o chamador
	// recriar o literal a cada render (comum ao passar props inline), depender
	// da identidade do objeto refaria o `listLogFiles` (readdir+stat) a cada
	// segundo, junto do polling de `readSince` abaixo.
	const filePath = useMemo(() => {
		if (!isFile) return undefined;
		return explicitFile ?? listLogFiles(dir).at(-1)?.path;
	}, [isFile, dir, explicitFile]);

	const initial = useRef<{ lines: string[]; size: number } | null>(null);
	if (initial.current === null) {
		initial.current = filePath
			? tailFile(filePath, FILE_TAIL_LINES)
			: { lines: [], size: 0 };
	}
	const [fileLines, setFileLines] = useState<string[]>(initial.current.lines);
	const offsetRef = useRef(initial.current.size);

	useEffect(() => {
		if (!isFile || !filePath) return;
		const id = setInterval(() => {
			const { lines: fresh, size } = readSince(filePath, offsetRef.current);
			offsetRef.current = size;
			if (fresh.length === 0) return;
			setFileLines((prev) => [...prev, ...fresh].slice(-MAX_LINES));
		}, POLL_MS);
		return () => clearInterval(id);
	}, [isFile, filePath]);

	const proc = useProcess(MAX_LINES);
	const startedLive = useRef(false);

	useEffect(() => {
		if (source.kind !== "live" || startedLive.current) return;
		startedLive.current = true;
		proc.start(
			tailCommand(source.backend, source.name, {
				workingDir: source.dir,
				label: source.label,
			}),
			{ cwd: source.dir },
		);
	}, [proc, source]);

	// Checa `source.kind` de novo (não a variável `isFile`): o TypeScript só
	// estreita o tipo da união a partir de uma condição direta sobre o campo
	// discriminante, não a partir de um booleano derivado.
	if (source.kind === "file") {
		return {
			lines: fileLines,
			title: filePath ? basename(filePath) : "nenhum log gravado",
			live: null,
		};
	}
	return {
		lines: proc.lines,
		title: `ao vivo · ${source.name}`,
		live: { running: proc.running },
	};
}
