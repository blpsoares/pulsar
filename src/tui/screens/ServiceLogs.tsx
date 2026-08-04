import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { filterLines } from "../../core/logs/readLog";
import { tailCommand } from "../../core/logs/tailCommand";
import { levelOf } from "../../core/run/logLines";
import {
	type DiscoveredService,
	discoverServices,
} from "../../core/service/discover";
import type { Backend } from "../../core/service/types";
import {
	type Chip,
	layout,
	Panel,
	RAIL_WIDTH,
	Shell,
	Stat,
} from "../components/Shell";
import { type ProcState, useProcess } from "../hooks/useProcess";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { useClickable } from "../mouse/MouseProvider";
import { isMouseInput } from "../mouse/parse";
import { glyph, theme } from "../theme";

/**
 * Aba "serviço": o log AO VIVO de quem está em background.
 *
 * Complementa a aba "logs", que lê `./logs/*.log` — o que o winston GRAVOU.
 * Aqui se lê o que o SUPERVISOR guardou: journal do systemd, arquivo do pm2,
 * driver de log do docker, `.out.log` do launchd. É onde aparece o que o
 * processo imprimiu antes de o logger inicializar (justamente o crash que a
 * gente quer ver) e o que ele imprimiu num restart automático.
 *
 * A lista à esquerda vem de `discoverServices()`: parte do que EXISTE no ar, não
 * de uma config. Antes, seguir um log ao vivo exigia adivinhar o backend pelo
 * `preferredBackend()` e o nome pelo nome do arquivo yml — dava para acabar
 * seguindo o journal de uma unit que não existe enquanto o serviço rodava no
 * docker. Aqui o par (backend, nome) vem do próprio supervisor, então o seguidor
 * aponta necessariamente para o processo certo.
 */

/** Buffer circular do log: teto de memória com passado suficiente para rolar. */
const MAX_LINES = 2000;

/** Identidade estável de um serviço: dois supervisores podem repetir o nome. */
function keyOf(service: DiscoveredService): string {
	return `${service.backend}:${service.name}`;
}

export function ServiceLogsScreen({
	dir,
	onExit,
}: {
	dir: string;
	onExit: () => void;
}) {
	const { columns, rows } = useTerminalSize();
	// Trilho à esquerda: aqui a coluna é CONTEÚDO (de qual serviço é este log),
	// não navegação global — essa vive nas abas do topo.
	const l = layout(columns, rows, RAIL_WIDTH);

	const [services, setServices] = useState<DiscoveredService[] | null>(null);
	const [index, setIndex] = useState(0);
	/**
	 * Serviço COMPROMETIDO (aquele cujo log está sendo seguido), separado do
	 * cursor da lista: cada troca derruba um processo filho e sobe outro, e fazer
	 * isso a cada seta seria disparar (e matar) um `journalctl` por tecla. O
	 * cursor anda livre; `enter` (ou clique no item sob o cursor) compromete.
	 */
	const [followed, setFollowed] = useState<string | null>(null);
	const [pane, setPane] = useState<"list" | "log">("log");
	/**
	 * Contador de recargas. Entra na `key` do seguidor para que `R` REABRA o
	 * processo mesmo com o mesmo serviço selecionado — sem isso, um seguidor que
	 * caiu (container removido e recriado, unit reiniciada) ficaria morto na tela
	 * e a única saída seria trocar de serviço e voltar.
	 */
	const [reloads, setReloads] = useState(0);
	/** busca aberta ⇒ `1..4` tem que escrever o dígito, não pular de aba */
	const [typing, setTyping] = useState(false);

	const refresh = useCallback(async () => {
		const found = await discoverServices();
		setServices(found);
		// Primeira carga: já entra seguindo alguém. `discoverServices` ordena os
		// que estão no ar primeiro, então o item 0 é a resposta certa para "o que
		// está acontecendo agora?".
		setFollowed((current) => {
			if (current && found.some((s) => keyOf(s) === current)) return current;
			const first = found[0];
			return first ? keyOf(first) : null;
		});
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const list = services ?? [];
	const cursor = Math.min(index, Math.max(0, list.length - 1));
	const selected = list[cursor];
	const current = list.find((s) => keyOf(s) === followed);

	useInput((input, key) => {
		if (isMouseInput(input) || typing) return;

		if (key.escape) {
			onExit();
			return;
		}
		// shift+tab é troca de ABA (tratada no Shell); `tab` sozinho é foco.
		if (key.tab && !key.shift) {
			setPane((p) => (p === "list" ? "log" : "list"));
			return;
		}
		if (input === "R") {
			setReloads((n) => n + 1);
			void refresh();
			return;
		}
		if (pane !== "list" || list.length === 0) return;

		if (key.upArrow) {
			setIndex(cursor === 0 ? list.length - 1 : cursor - 1);
			return;
		}
		if (key.downArrow) {
			setIndex(cursor === list.length - 1 ? 0 : cursor + 1);
			return;
		}
		if (key.return && selected) setFollowed(keyOf(selected));
	});

	const running = list.filter((s) => s.running).length;
	const chips: Chip[] = [
		{
			label: "no ar",
			value: services === null ? "…" : String(running),
			tone: running > 0 ? "ok" : "muted",
		},
		{
			label: "serviço",
			value: current ? current.name : "—",
			tone: current ? undefined : "muted",
		},
		{
			label: "supervisor",
			value: current ? current.backend : "—",
			tone: "muted",
		},
	];

	return (
		<Shell
			chips={chips}
			columns={columns}
			rows={rows}
			digitKeys={!typing}
			copy={() => current?.name ?? null}
			hints={[
				{ keys: "tab", label: "painel" },
				{ keys: "↑↓", label: pane === "list" ? "serviço" : "rolar" },
				...(pane === "list"
					? [{ keys: "enter", label: "seguir" }]
					: [
							{ keys: "/", label: "buscar" },
							{ keys: "f", label: "seguir" },
							{ keys: "g/G", label: "topo/fim" },
						]),
				{ keys: "R", label: "atualizar" },
				{ keys: "esc", label: "voltar" },
			]}
		>
			<Panel
				title="serviços"
				width={l.rail}
				height={l.body}
				focused={pane === "list"}
			>
				<ServiceList
					services={services}
					cursor={cursor}
					followed={followed}
					focused={pane === "list"}
					visible={l.panelRows - 1}
					onPick={(i) => {
						const target = list[i];
						if (!target) return;
						// Clique fora do cursor só move; clicar no item já sob o cursor é
						// que compromete. Mesma regra do Select — evita trocar de log (e
						// derrubar um processo) num clique de passagem.
						if (i === cursor && target) setFollowed(keyOf(target));
						else setIndex(i);
					}}
				/>
			</Panel>

			{current ? (
				<ServiceTail
					// A chave derruba o seguidor anterior no desmonte (SIGTERM em
					// `useProcess`) e sobe um novo — é o que garante que trocar de
					// serviço nunca deixe dois `journalctl` vivos.
					key={`${keyOf(current)}#${reloads}`}
					service={current}
					dir={dir}
					width={l.center}
					aside={l.aside}
					height={l.body}
					visibleRows={l.panelRows - 1}
					focused={pane === "log"}
					onSearching={setTyping}
				/>
			) : (
				<Empty
					loading={services === null}
					width={l.center}
					aside={l.aside}
					height={l.body}
				/>
			)}
		</Shell>
	);
}

// -------------------------------------------------------------------- lista

/**
 * Cada serviço ocupa DUAS linhas (nome e supervisor): num trilho de 22 colunas
 * não cabem os dois na mesma, e saber o supervisor é o que explica por que o
 * log tem a cara que tem. A constante existe porque o clique precisa da mesma
 * conta — o hit-testing entrega uma linha do painel, e ela vira índice aqui.
 */
const ROWS_PER_ITEM = 2;

function ServiceList({
	services,
	cursor,
	followed,
	focused,
	visible,
	onPick,
}: {
	services: DiscoveredService[] | null;
	cursor: number;
	followed: string | null;
	focused: boolean;
	/** linhas disponíveis no painel (não itens) */
	visible: number;
	onPick: (index: number) => void;
}) {
	const slots = Math.max(1, Math.floor(visible / ROWS_PER_ITEM));
	const total = services?.length ?? 0;
	const start = Math.max(
		0,
		Math.min(total - slots, cursor - Math.floor(slots / 2)),
	);

	const ref = useClickable({
		onClick: ({ row }) => onPick(start + Math.floor(row / ROWS_PER_ITEM)),
	});

	if (services === null) return <Text color={theme.muted}>procurando…</Text>;
	if (services.length === 0) return <Text color={theme.muted}>nada no ar</Text>;

	return (
		<Box flexDirection="column" ref={ref}>
			{services.slice(start, start + slots).map((service, i) => {
				const at = start + i;
				const active = at === cursor;
				const isFollowed = keyOf(service) === followed;

				return (
					<Box key={keyOf(service)} flexDirection="column">
						<Text
							color={
								active ? (focused ? theme.selection : theme.label) : undefined
							}
							bold={active}
							wrap="truncate-end"
						>
							{isFollowed ? "▍" : " "}
							<Text color={service.running ? theme.ok : theme.muted}>
								{service.running ? glyph.dot : glyph.unchecked}{" "}
							</Text>
							{service.name}
						</Text>
						<Text color={theme.muted} wrap="truncate-end">
							{"  "}
							{service.backend}
							{service.enabled ? " · boot" : ""}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

function Empty({
	loading,
	width,
	aside,
	height,
}: {
	loading: boolean;
	width: number;
	aside: number;
	height: number;
}) {
	return (
		<>
			<Panel title="log ao vivo" width={width} height={height}>
				{loading ? (
					<Text color={theme.muted}>procurando serviços…</Text>
				) : (
					<Box flexDirection="column">
						<Text color={theme.muted} wrap="wrap">
							nenhum serviço do pulsar no ar nesta máquina — não há saída ao
							vivo para seguir.
						</Text>
						<Box marginTop={1}>
							<Text color={theme.muted} wrap="wrap">
								abra a aba <Text color={theme.accent}>2 rodando</Text> para
								instalar um em background, ou tecle{" "}
								<Text color={theme.accent}>b</Text> sobre uma config na aba{" "}
								<Text color={theme.accent}>1 configs</Text> para subir num
								passo.
							</Text>
						</Box>
						<Box marginTop={1}>
							<Text color={theme.muted} wrap="wrap">
								o histórico que o winston gravou continua na aba{" "}
								<Text color={theme.accent}>3 logs</Text>, mesmo sem nada
								rodando.
							</Text>
						</Box>
						<Box marginTop={1}>
							<Text color={theme.muted}>
								<Text color={theme.accent}>R</Text> procura de novo.
							</Text>
						</Box>
					</Box>
				)}
			</Panel>

			{aside > 0 ? (
				<Panel title="seguidor" width={aside} height={height}>
					<Text color={theme.muted}>—</Text>
				</Panel>
			) : null}
		</>
	);
}

// ---------------------------------------------------------------- seguidor

/**
 * Segue o log de UM serviço pelo seguidor nativo do supervisor.
 *
 * O componente é montado com `key` do serviço: trocar de serviço desmonta este
 * e monta outro, e o desmonte do `useProcess` manda SIGTERM no filho. Sair da
 * aba desmonta a tela inteira, com o mesmo efeito. Nunca sobra um `journalctl
 * -f` pendurado.
 */
function ServiceTail({
	service,
	dir,
	width,
	aside,
	height,
	visibleRows,
	focused,
	onSearching,
}: {
	service: DiscoveredService;
	dir: string;
	width: number;
	aside: number;
	height: number;
	visibleRows: number;
	focused: boolean;
	onSearching: (active: boolean) => void;
}) {
	const proc = useProcess(MAX_LINES);
	const started = useRef(false);
	const [follow, setFollow] = useState(true);
	const [scroll, setScroll] = useState(0);
	const [query, setQuery] = useState("");
	const [searching, setSearchingState] = useState(false);

	const setSearching = useCallback(
		(active: boolean) => {
			setSearchingState(active);
			onSearching(active);
		},
		[onSearching],
	);

	// Trocar de serviço com a busca aberta deixaria a tela sem campo e o Shell
	// achando que ainda há um — os dígitos nunca voltariam a navegar.
	useEffect(() => () => onSearching(false), [onSearching]);

	useEffect(() => {
		// Guarda contra o efeito rodar duas vezes (StrictMode / re-render): dois
		// `start` seguidos seriam dois seguidores para o mesmo log.
		if (started.current) return;
		started.current = true;

		proc.start(
			tailCommand(service.backend, service.name, {
				workingDir: dir,
				// Só o launchd usa isto: ele não tem journal, escreve num arquivo
				// nomeado pelo label — e o label é exatamente o nome descoberto.
				label: service.name,
			}),
			{ cwd: dir },
		);
	}, [proc, service.backend, service.name, dir]);

	const ref = useClickable({
		onWheel: (direction) => {
			if (direction < 0) {
				setFollow(false);
				setScroll((s) => s + 3);
				return;
			}
			setScroll((s) => Math.max(0, s - 3));
		},
	});

	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;

			if (searching) {
				if (key.return || key.escape) {
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

			if (input === "/") {
				setSearching(true);
				return;
			}
			if (input === "f") {
				setFollow((f) => !f);
				return;
			}
			if (key.upArrow) {
				// Rolar para trás desliga o "seguir": senão a tela pularia de volta ao
				// fim a cada linha nova e ler o passado seria impossível.
				setFollow(false);
				setScroll((s) => s + 1);
				return;
			}
			if (key.downArrow) {
				setScroll((s) => Math.max(0, s - 1));
				return;
			}
			if (input === "g") {
				// Topo: o começo do que o buffer ainda guarda — não o começo do log do
				// serviço, que pode ter meses. Seguir e olhar o topo são incompatíveis.
				setFollow(false);
				setScroll(Number.MAX_SAFE_INTEGER);
				return;
			}
			if (input === "G") {
				setScroll(0);
				setFollow(true);
			}
		},
		{ isActive: focused },
	);

	const filtered = filterLines(proc.lines, query);
	// Com "seguir" ligado a janela fica colada no fim; o scroll só vale quando o
	// usuário assumiu o controle.
	const offset = follow
		? 0
		: Math.min(scroll, Math.max(0, filtered.length - 1));
	const end = Math.max(0, filtered.length - offset);
	const visible = filtered.slice(Math.max(0, end - visibleRows), end);
	const issue = followIssue(service.backend, proc.state, proc.lines);

	return (
		<>
			<Panel
				title={`ao vivo · ${service.name}${query ? ` · "${query}"` : ""}`}
				width={width}
				height={height}
				focused={focused}
				footer={
					searching ? (
						<Text color={theme.accent}>
							busca: {query}
							<Text inverse> </Text>
						</Text>
					) : undefined
				}
			>
				<Box flexDirection="column" ref={ref} flexGrow={1}>
					{visible.length === 0 ? (
						issue ? (
							<Box flexDirection="column">
								<Text color={theme.error} wrap="wrap">
									{issue.reason}
								</Text>
								<Box marginTop={1}>
									<Text color={theme.muted} wrap="wrap">
										{issue.fix}
									</Text>
								</Box>
							</Box>
						) : (
							<Text color={theme.muted} wrap="wrap">
								{query ? `nada com "${query}"` : waitingText(proc.state)}
							</Text>
						)
					) : (
						visible.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: janela de log é posicional
							<Text key={i} color={colorFor(line)} wrap="truncate-end">
								{line || " "}
							</Text>
						))
					)}
				</Box>
			</Panel>

			{aside > 0 ? (
				<Panel title="seguidor" width={aside} height={height}>
					<Stat label="backend" value={service.backend} width={aside} />
					<Stat
						label="serviço"
						value={service.running ? "no ar" : "parado"}
						width={aside}
						tone={service.running ? "ok" : "warn"}
					/>
					<Stat
						label="seguidor"
						value={followerLabel(proc.state)}
						width={aside}
						tone={
							proc.state === "running"
								? "ok"
								: proc.state === "failed"
									? "error"
									: "warn"
						}
					/>
					<Stat
						label="rolagem"
						value={follow ? "no fim" : `-${offset}`}
						width={aside}
						tone={follow ? "ok" : "warn"}
					/>
					<Stat
						label="linhas"
						value={String(filtered.length)}
						width={aside}
						tone="muted"
					/>

					{!service.running ? (
						<Box marginTop={1}>
							<Text color={theme.muted} wrap="wrap">
								o serviço está parado — o que aparece aqui é o histórico que o
								supervisor guardou.
							</Text>
						</Box>
					) : null}

					{issue ? (
						<Box marginTop={1}>
							<Text color={theme.warn} wrap="wrap">
								{issue.short}
							</Text>
						</Box>
					) : null}
				</Panel>
			) : null}
		</>
	);
}

// ------------------------------------------------------------- diagnóstico

/**
 * Painel sem nenhuma linha: qual dos silêncios é este?
 *
 * São três, e confundi-los faz o usuário esperar por algo que não vem: o
 * seguidor ainda subindo, o seguidor no ar com um serviço quieto, e o seguidor
 * que terminou (`docker logs` de um container removido, `pm2 logs` de um app
 * que sumiu). Só o segundo pede paciência.
 */
function waitingText(state: ProcState): string {
	if (state === "running")
		return "seguindo — o serviço ainda não imprimiu nada desde que esta tela abriu";
	if (state === "exited")
		return "o seguidor encerrou sozinho; R procura os serviços de novo e reabre";
	return "abrindo o seguidor…";
}

function followerLabel(state: ProcState): string {
	if (state === "running") return "ligado";
	if (state === "failed") return "falhou";
	if (state === "exited") return "encerrou";
	return "abrindo";
}

/** Binário que segue o log de cada supervisor — usado só nas mensagens de erro. */
const FOLLOWER: Record<Backend, string> = {
	systemd: "journalctl",
	pm2: "pm2",
	docker: "docker",
	launchd: "tail",
};

/**
 * Por que não há log na tela.
 *
 * Um painel vazio é a pior resposta possível: não distingue "o serviço está
 * quieto" de "o seguidor nem existe nesta máquina". Como o filho roda via
 * `useProcess`, tanto o ENOENT do spawn quanto o stderr do próprio seguidor
 * (`Failed to connect to bus`, `No such container`) chegam ao buffer de linhas —
 * então dá para responder com a causa real, e não com um genérico.
 */
export function followIssue(
	backend: Backend,
	state: ProcState,
	lines: string[],
): { reason: string; short: string; fix: string } | null {
	if (state !== "failed") return null;

	const text = lines.join("\n");
	const follower = FOLLOWER[backend];

	if (/falha ao iniciar/i.test(text) || /ENOENT/.test(text))
		return {
			reason: `o seguidor de log do ${backend} (\`${follower}\`) não está nesta máquina`,
			short: `${follower} ausente`,
			fix: `sem o comando não há como ler o log deste supervisor daqui — instale-o, ou leia o log gravado na aba 3 logs.`,
		};

	if (/failed to connect to bus|no medium found/i.test(text))
		return {
			reason:
				"o journal de usuário não responde: não há bus de systemd nesta sessão (típico de WSL e de container)",
			short: "systemd sem bus",
			fix: "o serviço pode ter sido instalado em outra sessão; rode a TUI onde o systemd de usuário existe, ou use a aba 3 logs.",
		};

	return {
		reason: `o seguidor encerrou: ${lastMeaningful(lines) || "sem mensagem"}`,
		short: "seguidor caiu",
		fix: "R atualiza a lista de serviços e reabre o seguidor.",
	};
}

/** Última linha com conteúdo — é onde o erro do seguidor costuma estar. */
function lastMeaningful(lines: string[]): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = (lines[i] ?? "").trim();
		if (line) return line.slice(0, 200);
	}
	return "";
}

function colorFor(line: string): string | undefined {
	const level = levelOf(line);
	if (level === "error") return theme.error;
	if (level === "warn") return theme.warn;
	if (level === "debug") return theme.muted;
	return undefined;
}
