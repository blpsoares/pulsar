import { Box, Text, useApp, useInput } from "ink";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { listLogFiles } from "../core/logs/readLog";
import { enableBoot } from "../core/service/enableBoot";
import { specFromRecord } from "../core/service/fromRecord";
import { controlService, uninstallService } from "../core/service/manager";
import { detectSudo, type SudoMode } from "../core/service/privileged";
import { defaultOps, switchBackend } from "../core/service/switchBackend";
import type { Backend, ServiceStep } from "../core/service/types";
import { adoptFromLive } from "../core/state/adopt";
import type { ServiceRow } from "../core/state/reconcile";
import {
	removeRecord,
	type ServiceRecord,
	writeRecord,
} from "../core/state/registry";
import { HelpOverlay } from "./components/HelpOverlay";
import { Overlay } from "./components/Overlay";
import { Select } from "./components/Select";
import { type Chip, layout, Panel, Shell } from "./components/Shell";
import { SudoConfirm } from "./components/SudoConfirm";
import { useTerminalSize } from "./hooks/useTerminalSize";
import { hintsFor, type KeyContext, type Layer as KeyLayer } from "./keys";
import { useMouse } from "./mouse/MouseProvider";
import { isMouseInput } from "./mouse/parse";
import { LogViewer, type LogViewerSource } from "./screens/LogViewer";
import { RunnerScreen } from "./screens/Runner";
import { ServiceDetail } from "./screens/ServiceDetail";
import { ServiceForm } from "./screens/ServiceForm";
import { ServicesPanel, useServiceRows } from "./screens/ServicesPanel";
import { theme } from "./theme";

/**
 * A TUI tem UMA tela: a lista de serviços. Tudo o mais é camada por cima dela.
 *
 * O roteador de seis telas saiu junto com o `tab` que trocava o foco entre
 * painéis vivos. Os dois resolviam a mesma pergunta errada ("qual painel está
 * escutando?") e produziam o mesmo defeito: `enter` agindo sobre o painel que
 * não estava sendo olhado. Aqui existe sempre exatamente um dono do teclado —
 * a camada do topo da pilha — e é isso que a prop `enabled` materializa.
 *
 * A LISTA NUNCA DESMONTA enquanto há overlay: é o que devolve o cursor ao mesmo
 * item quando a camada fecha. As duas camadas de TELA CHEIA (log e execução em
 * primeiro plano) são a exceção declarada — elas ocupam a tela inteira, sem
 * `Shell`, e o cursor sobrevive mesmo assim porque mora AQUI, no `App`, e não
 * dentro da lista.
 */

/**
 * Uma camada da pilha. O discriminante é `kind` (e não `name`) porque
 * `name` já é o nome do SERVIÇO em quase toda estrutura vizinha — duas coisas
 * diferentes com o mesmo campo é como se lê errado o código depois.
 *
 * Camada guarda o NOME do serviço, nunca o objeto `ServiceRow`: a lista é
 * relida a cada ação (`reloadKey`) e um row congelado na pilha mostraria o
 * estado de antes da operação que acabou de rodar.
 */
type LayerFrame =
	| { kind: "detail"; service: string }
	| { kind: "form"; initial?: ServiceRecord }
	| { kind: "logs"; service: string; sourceIndex: number }
	| { kind: "switch"; service: string }
	| { kind: "runner"; file: string }
	| { kind: "help" };

const BACKENDS: Backend[] = ["systemd", "docker", "pm2", "launchd"];

export function App({ dir }: { dir: string }) {
	const [stack, setStack] = useState<LayerFrame[]>([]);
	const [reloadKey, setReloadKey] = useState(0);
	const [cursor, setCursor] = useState(0);
	const [notice, setNotice] = useState<
		{ text: string; tone?: "ok" | "warn" | "error" } | undefined
	>();
	const [busy, setBusy] = useState<string | null>(null);
	const [sudoMode, setSudoMode] = useState<SudoMode | null>(null);
	const [askStep, setAskStep] = useState<ServiceStep | null>(null);
	const askResolver = useRef<((ok: boolean) => void) | null>(null);

	const { rows, loading } = useServiceRows(reloadKey);
	const { columns, rows: screenRows, tooSmall } = useTerminalSize();
	const { exit } = useApp();
	const mouse = useMouse();

	const top = stack.at(-1) ?? null;
	// A ajuda não é uma camada de conteúdo: ela descreve a de baixo, então as
	// teclas anunciadas (e o título) continuam sendo os da camada coberta.
	const beneath = top?.kind === "help" ? (stack.at(-2) ?? null) : top;

	const push = useCallback(
		(frame: LayerFrame) => setStack((s) => [...s, frame]),
		[],
	);
	const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);
	const reload = useCallback(() => setReloadKey((k) => k + 1), []);

	// `sudo -n true` uma vez, na abertura: é o preflight que a spec pede (saber
	// ANTES, não descobrir no fim) e o que alimenta o chip do cabeçalho. Não
	// abre prompt nenhum — `-n` justamente proíbe isso.
	useEffect(() => {
		void detectSudo().then(setSudoMode);
	}, []);

	/** Resolve o nome guardado na camada contra a lista RECÉM-LIDA. */
	const rowFor = (name: string): ServiceRow | undefined =>
		rows.find((r) => r.name === name);

	const selected = rows[Math.min(cursor, Math.max(0, rows.length - 1))];

	// ------------------------------------------------------------ operações

	const ask = useCallback(
		(step: ServiceStep) =>
			new Promise<boolean>((finish) => {
				askResolver.current = finish;
				setAskStep(step);
			}),
		[],
	);

	const sudoRef = useRef<SudoMode | null>(null);
	sudoRef.current = sudoMode;
	async function currentSudo(): Promise<SudoMode> {
		return sudoRef.current ?? (await detectSudo());
	}

	/**
	 * Toda operação de serviço passa por aqui: uma por vez (`busy`), erro vira
	 * AVISO na barra em vez de derrubar o painel, e a lista é sempre relida no
	 * fim — o estado exibido tem que ser o de depois da operação.
	 */
	async function operate(label: string, fn: () => Promise<string | null>) {
		if (busy) return;
		setBusy(label);
		try {
			const message = await fn();
			if (message) setNotice({ text: message, tone: "ok" });
		} catch (err) {
			setNotice({
				text: err instanceof Error ? err.message : String(err),
				tone: "error",
			});
		} finally {
			setBusy(null);
			reload();
		}
	}

	function control(row: ServiceRow, action: "start" | "stop" | "restart") {
		const record = row.record;
		if (!record) return;
		void operate(`${action}…`, async () => {
			const result = await controlService(
				record.backend,
				specFromRecord(record),
				action,
			);
			if (result.ok) return `${row.name}: ${action} ok`;
			setNotice({ text: firstLine(result.output), tone: "error" });
			return null;
		});
	}

	function remove(row: ServiceRow) {
		const record = row.record;
		void operate("removendo…", async () => {
			// O registro só some depois que o supervisor CONFIRMA que o serviço
			// caiu. Apagar antes (o que se fazia) deixava um container no ar sem
			// nenhum registro apontando para ele: a tela dizia "removido", o sync
			// continuava escrevendo no destino, e criar outro na mesma config
			// colocaria dois disputando o resume token global em `__sync`.
			if (record) {
				const result = await uninstallService(
					record.backend,
					specFromRecord(record),
				);
				if (!result.ok) {
					setNotice({
						text: `${row.name} NÃO foi removido — ${
							result.status?.detail ?? "ainda aparece no supervisor"
						}. O registro foi mantido.`,
						tone: "error",
					});
					return null;
				}
			}
			removeRecord(row.name);
			setStack([]);
			return `${row.name} removido`;
		});
	}

	function adopt(row: ServiceRow) {
		const live = row.live;
		if (!live) return;
		void operate("adotando…", async () => {
			const result = await adoptFromLive(live, dir);
			if (!result.ok) {
				setNotice({ text: result.error, tone: "error" });
				return null;
			}
			writeRecord(result.record);
			return `${row.name} adotado — registro gravado em ~/.pulsar`;
		});
	}

	function ligarBoot(row: ServiceRow) {
		const record = row.record;
		if (!record) return;
		void operate("ligando o boot…", async () => {
			const outcome = await enableBoot(record, {
				sudo: await currentSudo(),
				ask,
				onOutput: (line) => setBusy(firstLine(line).slice(0, 60)),
			});
			if (outcome.unsupported) {
				setNotice({
					text: "no launchd o boot mora no plist: edite o serviço e reinstale",
					tone: "warn",
				});
				return null;
			}
			if (outcome.skipped.length > 0) {
				setNotice({
					text: `boot ainda pendente: falta rodar ${describe(outcome.skipped[0])}`,
					tone: "warn",
				});
				return null;
			}
			if (!outcome.ok) {
				setNotice({
					text: firstLine(outcome.results.at(-1)?.output ?? "falhou"),
					tone: "error",
				});
				return null;
			}
			return `${row.name}: boot automático ligado`;
		});
	}

	function trocarBackend(row: ServiceRow, target: Backend) {
		const record = row.record;
		if (!record) return;
		void operate(`trocando para ${target}…`, async () => {
			const outcome = await switchBackend(
				record,
				target,
				defaultOps({ sudo: await currentSudo(), ask }),
			);
			if (outcome.ok) return `${row.name} agora roda no ${target}`;
			setNotice({
				text: `${firstLine(outcome.error)} — ${
					outcome.rolledBack
						? `voltou para ${record.backend}`
						: `ATENÇÃO: o rollback para ${record.backend} também falhou`
				}`,
				tone: "error",
			});
			return null;
		});
	}

	// ------------------------------------------------------------- teclado

	useInput((input, key) => {
		if (isMouseInput(input)) return;

		// Ctrl+D encerra de QUALQUER camada. O `render()` roda com
		// `exitOnCtrlC: false` (para um sync disparado pela TUI receber SIGTERM e
		// gravar o resume token), então sem isto não haveria saída garantida;
		// Ctrl+C passou a copiar (tratado no `Shell`).
		if (key.ctrl && input === "d") {
			exit();
			return;
		}

		// A confirmação de sudo tem teclado próprio, logo abaixo.
		if (askStep) return;

		if (top?.kind === "help") {
			if (key.escape || input === "?") pop();
			return;
		}

		// SAÍDA POR `esc` DE TODA CAMADA QUE NÃO TRATA O TECLADO SOZINHA.
		//
		// `detail`, `form` e `logs` têm handler próprio e fecham a si mesmos; a
		// modal de troca de backend não tem (o `Select` só entende ↑↓ e enter) e
		// virou um beco sem saída: com o detalhe já desabilitado por baixo, as
		// únicas saídas eram encerrar a TUI ou ESCOLHER — disparando na hora a
		// troca destrutiva. É o defeito do commit 4f8493d ("passo 'modo' era uma
		// tela sem saída") de volta. Camada nova sem teclado próprio entra aqui.
		if (key.escape && top?.kind === "switch") {
			pop();
			return;
		}

		// `?` das camadas com CAMPO DE TEXTO (formulário, busca do log) é tratado
		// dentro delas, via `onHelp`: uma URI do Atlas tem `?retryWrites=true`, e
		// um handler global roubaria essa tecla no meio da digitação.
		if (
			input === "?" &&
			(top === null || top.kind === "detail" || top.kind === "switch")
		) {
			push({ kind: "help" });
			return;
		}

		if (top === null && input === "m") mouse.toggle();
	});

	// Confirmação de um passo com sudo — o mesmo contrato do formulário:
	// `enter` digita a senha agora (o TTY é entregue ao sudo), `p`/`esc` pula, e
	// pular não faz a operação falhar.
	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (!askStep) return;
			if (key.return) {
				askResolver.current?.(true);
				setAskStep(null);
			} else if (input === "p" || key.escape) {
				askResolver.current?.(false);
				setAskStep(null);
			}
		},
		{ isActive: Boolean(askStep) },
	);

	// --------------------------------------------------------------- render

	if (tooSmall)
		return (
			<Box flexDirection="column" padding={1}>
				<Text color={theme.warn}>
					terminal pequeno demais ({columns}×{screenRows}) — aumente a janela
				</Text>
				<Text color={theme.muted}>ctrl+d sai</Text>
			</Box>
		);

	const detailRow =
		beneath?.kind === "detail" || beneath?.kind === "switch"
			? rowFor(beneath.service)
			: undefined;

	const keyLayer: KeyLayer =
		beneath?.kind === "logs"
			? "logs"
			: beneath?.kind === "form"
				? "form"
				: beneath?.kind === "switch"
					? "switch"
					: beneath?.kind === "detail"
						? "detail"
						: "list";

	// O que a ajuda e a barra podem anunciar HONESTAMENTE para este serviço.
	const keyContext: KeyContext = {
		adopted: detailRow?.state === "adopted",
		bootPending: Boolean(
			detailRow?.record &&
				detailRow.record.mode === "sync" &&
				!detailRow.record.boot,
		),
		hasResult: Boolean(detailRow?.record?.lastRun),
	};

	const help =
		top?.kind === "help" ? (
			<HelpOverlay
				layer={keyLayer}
				columns={columns}
				rows={screenRows}
				context={keyContext}
			/>
		) : null;

	// ---- camadas de TELA CHEIA (sem Shell: são conteúdo e nada mais)
	if (beneath?.kind === "logs") {
		const row = rowFor(beneath.service);
		const sources = row ? logSourcesFor(row, dir) : [];
		const index = beneath.sourceIndex % Math.max(1, sources.length);
		const source: LogViewerSource = sources[index] ?? { kind: "file", dir };

		return (
			<Box flexDirection="column" width={columns} height={screenRows}>
				<LogViewer
					// Trocar de fonte remonta: rolagem e busca são do TEXTO, não da tela.
					key={`${beneath.service}:${index}`}
					source={source}
					columns={columns}
					rows={screenRows}
					enabled={top?.kind !== "help"}
					onHelp={() => push({ kind: "help" })}
					onCycleSource={() =>
						setStack((s) =>
							s.map((f, i) =>
								i === s.length - 1 && f.kind === "logs"
									? { ...f, sourceIndex: f.sourceIndex + 1 }
									: f,
							),
						)
					}
					onClose={pop}
				/>
				{help}
			</Box>
		);
	}

	if (beneath?.kind === "runner") {
		return (
			<Box flexDirection="column" width={columns} height={screenRows}>
				<RunnerScreen
					file={beneath.file}
					onExit={() => {
						pop();
						reload();
					}}
				/>
				{help}
			</Box>
		);
	}

	// ---- camadas em OVERLAY, com a lista viva por baixo
	const overlays: ReactNode[] = [];
	for (const [i, frame] of stack.entries()) {
		const isTop = i === stack.length - 1 && !askStep;

		if (frame.kind === "detail") {
			const row = rowFor(frame.service);
			if (!row) continue;
			overlays.push(
				<ServiceDetail
					key="detail"
					row={row}
					columns={columns}
					rows={screenRows}
					busy={busy}
					enabled={isTop}
					onClose={pop}
					onControl={(action) => control(row, action)}
					onRun={() =>
						row.record && push({ kind: "runner", file: row.record.config })
					}
					onEdit={() =>
						row.record && push({ kind: "form", initial: row.record })
					}
					onSwitchBackend={() => push({ kind: "switch", service: row.name })}
					onLogs={() =>
						push({ kind: "logs", service: row.name, sourceIndex: 0 })
					}
					onRemove={() => remove(row)}
					onAdopt={() => adopt(row)}
					onEnableBoot={() => ligarBoot(row)}
				/>,
			);
			continue;
		}

		if (frame.kind === "switch") {
			const row = rowFor(frame.service);
			if (!row?.record) continue;
			const atual = row.record.backend;
			overlays.push(
				<Overlay
					key="switch"
					title={`trocar inicialização · ${row.name}`}
					columns={columns}
					rows={screenRows}
				>
					<Text color={theme.muted} wrap="wrap">
						hoje roda no {atual}. o pulsar remove de lá, instala no escolhido e
						sobe — se o novo falhar, reinstala no antigo.
					</Text>
					<Box marginTop={1}>
						<Select
							items={BACKENDS.filter((b) => b !== atual).map((b) => ({
								value: b,
								label: b,
							}))}
							onSelect={(value) => {
								pop();
								trocarBackend(row, value as Backend);
							}}
							focus={isTop}
							visible={4}
						/>
					</Box>
				</Overlay>,
			);
			continue;
		}

		if (frame.kind === "form") {
			overlays.push(
				<ServiceForm
					key="form"
					dir={dir}
					initial={frame.initial}
					columns={columns}
					rows={screenRows}
					enabled={isTop}
					onHelp={() => push({ kind: "help" })}
					onCancel={pop}
					onSubmit={(draft, andStart) => {
						setStack([]);
						reload();
						setNotice({
							text: andStart
								? `${draft.name} criado e iniciado`
								: `${draft.name} gravado (não iniciado)`,
							tone: "ok",
						});
					}}
				/>,
			);
		}
	}

	if (help) overlays.push(help);

	// ALERTA: este push vem DEPOIS dos early returns de tela cheia — se um dia
	// uma operação com sudo puder ser disparada com o log ou o runner no topo,
	// a confirmação não aparecerá e a operação ficará esperando uma tecla que
	// ninguém vê. Hoje as duas que pedem sudo (ligar boot, trocar backend)
	// partem do detalhe, que é caminho de overlay.
	if (askStep)
		overlays.push(
			<SudoConfirm
				key="ask"
				step={askStep}
				columns={columns}
				rows={screenRows}
			/>,
		);

	const l = layout(columns, screenRows);

	return (
		<Shell
			chips={chipsFor(rows, loading, sudoMode, busy)}
			columns={columns}
			rows={screenRows}
			hints={hintsFor(keyLayer, keyContext)}
			notice={notice}
			// Ctrl+C leva para fora o que serve de verdade: o caminho do yml
			// (colável num `pulsar sync …`) e, sem registro, o nome do serviço.
			// Só na RAIZ: `ctrl+c` é anunciado em `KEYS.list` e em nenhuma outra
			// camada, e com um formulário aberto ele copiava o item da lista de
			// BAIXO — atalho invisível agindo sobre o que não está em foco. Sem a
			// prop, o `Shell` nem escuta a tecla (o log tem a sua própria, que
			// copia a linha em foco).
			copy={
				stack.length === 0
					? () => (selected ? (selected.record?.config ?? selected.name) : null)
					: undefined
			}
			overlay={overlays.length > 0 ? overlays : undefined}
		>
			<Panel title="serviços" width={columns} height={l.body} focused>
				<ServicesPanel
					rows={rows}
					loading={loading}
					columns={columns}
					screenRows={l.panelRows}
					cursor={cursor}
					setCursor={setCursor}
					enabled={stack.length === 0 && !askStep}
					onOpen={(row) => push({ kind: "detail", service: row.name })}
					onNew={() => push({ kind: "form" })}
					onLogs={(row) =>
						push({ kind: "logs", service: row.name, sourceIndex: 0 })
					}
					onReload={reload}
					onQuit={exit}
				/>
			</Panel>
		</Shell>
	);
}

/**
 * As fontes de log daquele serviço, na ordem em que `s` as percorre: primeiro o
 * seguidor ao vivo do supervisor (o que se quer olhar em 9 de 10 vezes), depois
 * cada arquivo gravado em `./logs` do diretório de trabalho DELE.
 */
function logSourcesFor(
	row: ServiceRow,
	fallbackDir: string,
): LogViewerSource[] {
	const workingDir = row.record?.workingDir ?? fallbackDir;
	const backend = row.record?.backend ?? row.live?.backend;
	const sources: LogViewerSource[] = [];

	// O seguidor ao vivo fala com o SUPERVISOR, então precisa do nome que ele
	// conhece (`pulsar-sync-x` no docker, `com.pulsar.x` no launchd) — e não do
	// nome do registro, que é o de `row.name`. `row.live` é a fonte exata disso;
	// sem serviço vivo não há o que seguir mesmo.
	const liveName = row.live?.name ?? row.name;

	if (backend)
		sources.push({
			kind: "live",
			dir: workingDir,
			backend,
			name: liveName,
			// No launchd o nome do serviço JÁ é o label (é assim que o discover o
			// enxerga), então serve para os dois campos.
			label: liveName,
		});

	for (const file of listLogFiles(workingDir))
		sources.push({ kind: "file", dir: workingDir, file: file.path });

	if (sources.length === 0) sources.push({ kind: "file", dir: workingDir });
	return sources;
}

function chipsFor(
	rows: ServiceRow[],
	loading: boolean,
	sudo: SudoMode | null,
	busy: string | null,
): Chip[] {
	const running = rows.filter((r) => r.state === "running").length;

	return [
		{
			label: "serviços",
			value: loading ? "…" : `${running}/${rows.length} no ar`,
			tone: running > 0 ? "ok" : "muted",
		},
		{
			label: "sudo",
			value:
				sudo === null
					? "…"
					: sudo === "passwordless"
						? "liberado"
						: "pede senha",
			tone: sudo === "passwordless" ? "ok" : "warn",
		},
		...(busy ? [{ label: "rodando", value: busy, tone: "warn" as const }] : []),
	];
}

function describe(step: ServiceStep): string {
	return `${step.cmd} ${step.args.join(" ")}`.trim();
}

function firstLine(text: string): string {
	return (
		text.split("\n").filter(Boolean).at(-1)?.slice(0, 160) ?? "sem detalhe"
	);
}
