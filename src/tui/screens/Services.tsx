import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { detectConfigs } from "../../core/compose/detectConfigs";
import type { ResourceRec } from "../../core/compose/recommend";
import { loadConfigFile } from "../../core/config/loadConfig";
import {
	type BackendAvailability,
	detectBackends,
	preferredBackend,
} from "../../core/service/detect";
import { BASE_COMPOSE } from "../../core/service/dockerService";
import {
	buildPlan,
	controlService,
	type InstallResult,
	installService,
	type StepResult,
	serviceStatus,
	uninstallService,
} from "../../core/service/manager";
import type {
	Backend,
	InstallPlan,
	ServiceSpec,
	ServiceStatus,
} from "../../core/service/types";
import { Select } from "../components/Select";
import {
	type Chip,
	layout,
	Panel,
	RAIL_WIDTH,
	Shell,
	Stat,
	shortenPath,
} from "../components/Shell";
import { TextInput } from "../components/TextInput";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { isMouseInput } from "../mouse/parse";
import { theme } from "../theme";

/**
 * Rodar em background e subir no boot.
 *
 * Backends à esquerda (com o motivo quando indisponíveis), plano no centro,
 * estado do serviço à direita. O plano — arquivos que serão gravados e comandos
 * que serão executados — fica visível ANTES de qualquer efeito: instalar
 * serviço mexe no boot da máquina, e o usuário merece ver o que vai acontecer.
 */

export function ServicesScreen({
	dir,
	file: initialFile,
	onExit,
}: {
	dir: string;
	file?: string;
	onExit: () => void;
}) {
	const { columns, rows } = useTerminalSize();

	const configs = detectConfigs(dir, { recursive: true }).filter(
		(c) => c.kind !== "desconhecido",
	);
	const [file, setFile] = useState<string | undefined>(initialFile);
	const [backend, setBackend] = useState<Backend | null>(null);
	const [availability, setAvailability] = useState<
		BackendAvailability[] | null
	>(null);
	const [autostart, setAutostart] = useState(true);
	const [status, setStatus] = useState<ServiceStatus | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [result, setResult] = useState<InstallResult | null>(null);
	const [actionLog, setActionLog] = useState<StepResult[]>([]);
	const [pane, setPane] = useState<"backend" | "config">(
		initialFile ? "backend" : "config",
	);
	/**
	 * Cerca de RAM/CPU escolhida à mão. `null` = usar a recomendada, que é
	 * recalculada a cada plano (ela depende do que as outras instâncias já
	 * comprometeram, e isso muda quando se instala ou remove uma).
	 */
	const [resources, setResources] = useState<ResourceRec | null>(null);
	const [editingRes, setEditingRes] = useState(false);
	const l = layout(columns, rows, RAIL_WIDTH);

	useEffect(() => {
		void detectBackends(existsSync(join(dir, BASE_COMPOSE))).then((a) => {
			setAvailability(a);
			setBackend((b) => b ?? preferredBackend(a));
		});
	}, [dir]);

	function specFor(name: string): ServiceSpec | null {
		const path = resolve(dir, name);
		const loaded = loadConfigFile(path);
		if (!loaded) return null;
		return {
			name: basename(name).replace(/\.ya?ml$/i, ""),
			mode: loaded.form.mode,
			configPath: path,
			workingDir: dir,
			autostart,
		};
	}

	/**
	 * `specFor` lê e parseia o yml, e `buildPlan` do docker chega a rodar um
	 * `spawnSync` (a sonda de `systemctl is-enabled docker`). No corpo do render
	 * isso acontecia a cada redesenho — inclusive a cada tecla —, travando a UI
	 * por um processo filho síncrono que responde sempre a mesma coisa.
	 */
	// biome-ignore lint/correctness/useExhaustiveDependencies: specFor deriva de file/dir/autostart, já listados
	const spec = useMemo(
		() => (file ? specFor(file) : null),
		[file, dir, autostart],
	);
	const plan = useMemo(
		() =>
			spec && backend ? buildPlan(backend, spec, resources ?? undefined) : null,
		[spec, backend, resources],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: specFor deriva de file/dir/autostart, já listados
	useEffect(() => {
		if (!spec || !backend) return;
		let alive = true;
		void serviceStatus(backend, spec).then((s) => {
			if (alive) setStatus(s);
		});
		return () => {
			alive = false;
		};
	}, [file, backend, dir, autostart]);

	useInput((input, key) => {
		// Com o editor de recursos aberto, ele é quem manda: sem esta saída, o
		// mesmo toque digitaria no campo E acionaria o atalho da tela por baixo.
		if (busy || editingRes) return;
		if (isMouseInput(input)) return;

		if (key.escape) {
			onExit();
			return;
		}
		// Ajustar a cerca de RAM/CPU só faz sentido onde ela existe (docker).
		if (input === "e" && plan && !("error" in plan) && plan.resources) {
			setEditingRes(true);
			return;
		}
		// shift+tab troca de ABA (Shell); `tab` sozinho é foco entre painéis.
		if (key.tab && !key.shift) {
			setPane((p) => (p === "backend" ? "config" : "backend"));
			return;
		}
		if (input === "s") {
			setAutostart((a) => !a);
			return;
		}
		if (!spec || !backend || !plan || "error" in plan) return;

		if (key.return) {
			setBusy("instalando…");
			void installService(plan, spec).then((r) => {
				setBusy(null);
				setResult(r);
				void serviceStatus(backend, spec).then(setStatus);
			});
			return;
		}
		if (input === "x") {
			setBusy("removendo…");
			void uninstallService(backend, spec).then((r) => {
				setBusy(null);
				setActionLog(r);
				setResult(null);
				void serviceStatus(backend, spec).then(setStatus);
			});
			return;
		}
		if (input === "i" || input === "p" || input === "t") {
			const action =
				input === "i" ? "start" : input === "p" ? "stop" : "restart";
			setBusy(`${action}…`);
			void controlService(backend, spec, action).then((r) => {
				setBusy(null);
				setActionLog([r]);
				void serviceStatus(backend, spec).then(setStatus);
			});
		}
	});

	const chips: Chip[] = [
		{ label: "config", value: file ?? "—", tone: file ? "muted" : "warn" },
		{ label: "backend", value: backend ?? "detectando…" },
		{
			label: "boot",
			value: autostart ? "sim" : "não",
			tone: autostart ? "ok" : "muted",
		},
	];

	return (
		<Shell
			chips={chips}
			columns={columns}
			rows={rows}
			notice={busy ? { text: busy } : undefined}
			/**
			 * Com uma falha na tela, `ctrl+c` leva o erro COMPLETO — inclusive as
			 * linhas que não couberam no bloco. É o que permite colar o erro num
			 * chat ou numa issue sem repetir o comando à mão fora da TUI.
			 */
			copy={() => {
				const falho =
					result?.results.find((r) => !r.ok && r.raw) ??
					actionLog.find((r) => !r.ok && r.raw);
				if (falho?.raw)
					return `$ ${falho.step.cmd} ${falho.step.args.join(" ")}\n${falho.raw}`;
				return file ? resolve(dir, file) : null;
			}}
			hints={[
				{ keys: "tab", label: "painel" },
				{ keys: "enter", label: "instalar" },
				{ keys: "i/p/t", label: "iniciar/parar/reiniciar" },
				{ keys: "x", label: "remover" },
				{ keys: "s", label: "boot" },
				// Só anuncia onde a tecla faz algo — prometer um atalho que não
				// responde é pior do que não ter o atalho.
				...(plan && !("error" in plan) && plan.resources
					? [{ keys: "e", label: "recursos (RAM/CPU)" }]
					: []),
				{ keys: "esc", label: "voltar" },
			]}
		>
			{/*
			 * `tab` alterna o FOCO entre os dois painéis da esquerda; o centro é
			 * sempre o plano. Antes o tab trocava o conteúdo do centro (lista de
			 * configs ↔ plano), e mudar o que está na tela ao mudar de foco
			 * desorienta: some da vista justamente o que se está decidindo.
			 */}
			<Box flexDirection="column" width={l.rail}>
				<Panel
					title="config"
					width={l.rail}
					focused={pane === "config"}
					height={Math.max(6, Math.min(configs.length + 3, l.body - 9))}
				>
					<Select
						items={configs.map((c) => ({
							value: c.file,
							// encurta pelo MEIO: no trilho estreito, cortar o fim apagaria
							// justamente o nome do arquivo, que é o que identifica a config
							label: shortenPath(c.file, l.rail - 6),
						}))}
						onSelect={(f) => {
							setFile(f);
							setResult(null);
							setActionLog([]);
						}}
						focus={pane === "config"}
						emptyMessage="nenhuma config"
						visible={Math.max(3, Math.min(configs.length, l.body - 12))}
						initialIndex={Math.max(
							0,
							configs.findIndex((c) => c.file === file),
						)}
					/>
				</Panel>

				<Panel title="backend" width={l.rail} focused={pane === "backend"} grow>
					{availability === null ? (
						<Text color={theme.muted}>checando…</Text>
					) : (
						<Select
							items={availability.map((a) => ({
								value: a.backend,
								label: a.backend,
								disabled: !a.available,
							}))}
							onSelect={setBackend}
							focus={pane === "backend"}
							visible={6}
							initialIndex={Math.max(
								0,
								availability.findIndex((a) => a.backend === backend),
							)}
						/>
					)}
				</Panel>
			</Box>

			{/*
			 * O centro é SEMPRE o plano. Antes ele alternava para uma segunda lista
			 * de configs quando o foco ia para a esquerda — duplicando a lista que
			 * já está lá e fazendo o `tab` mudar o conteúdo da tela, não só o foco.
			 */}
			<Panel
				title={`plano${backend ? ` · ${backend}` : ""}`}
				width={l.center}
				height={l.body}
			>
				{!file ? (
					<Text color={theme.muted}>
						escolha a config no painel da esquerda (tab alterna o foco)
					</Text>
				) : !plan ? (
					<Text color={theme.muted}>detectando backend…</Text>
				) : "error" in plan ? (
					<Text color={theme.error} wrap="wrap">
						✖ {plan.error}
					</Text>
				) : editingRes && plan.resources ? (
					<ResourceEditor
						initial={plan.resources}
						onCancel={() => setEditingRes(false)}
						onSubmit={(next) => {
							setResources(next);
							setEditingRes(false);
						}}
					/>
				) : (
					<PlanView plan={plan} result={result} actionLog={actionLog} />
				)}
			</Panel>

			{l.aside > 0 ? (
				<Panel title="serviço" width={l.aside} height={l.body}>
					<StatusPanel
						status={status}
						width={l.aside}
						availability={availability}
						backend={backend}
					/>
				</Panel>
			) : null}
		</Shell>
	);
}

function PlanView({
	plan,
	result,
	actionLog,
}: {
	plan: InstallPlan;
	result: InstallResult | null;
	actionLog: StepResult[];
}) {
	return (
		<Box flexDirection="column">
			{/*
			 * A cerca de RAM/CPU é o número mais consequente do plano do docker —
			 * é ele que decide se um estouro de memória mata só o container ou
			 * derruba a VM. Ficava calculado por dentro e invisível: o pulsar
			 * escolhia o teto da máquina sem dizer a ninguém.
			 */}
			{plan.resources ? (
				<>
					<Text color={theme.border}>─ recursos ─</Text>
					<Text wrap="truncate-end">
						<Text color={theme.label}>mem {plan.resources.memLimitMiB}m</Text>
						<Text color={theme.muted}>
							{" "}
							· reserva {plan.resources.memReservMiB}m · cpus{" "}
							{plan.resources.cpus}
						</Text>
					</Text>
					<Text color={theme.muted} wrap="wrap">
						teto duro: no estouro o kernel mata o container, não a VM. `e`
						ajusta.
					</Text>
				</>
			) : null}

			<Text color={theme.border}>─ arquivos ─</Text>
			{plan.files.map((f) => (
				<Text key={f.path} color={theme.muted} wrap="truncate-middle">
					{f.path}
				</Text>
			))}

			<Text color={theme.border}>─ comandos ─</Text>
			{plan.steps.map((s) => (
				<Text key={s.cmd + s.args.join()} wrap="truncate-end">
					<Text color={theme.label}>
						{s.cmd} {s.args.join(" ")}
					</Text>
					<Text color={theme.muted}> — {s.why}</Text>
				</Text>
			))}

			{plan.manualSteps.length > 0 ? (
				<>
					<Text color={theme.warn}>─ você roda à mão (pedem sudo) ─</Text>
					{plan.manualSteps.map((s) => (
						<Text key={s.cmd + s.args.join()} wrap="truncate-end">
							<Text color={theme.warn}>
								{s.cmd} {s.args.join(" ")}
							</Text>
							<Text color={theme.muted}> — {s.why}</Text>
						</Text>
					))}
				</>
			) : null}

			{plan.notes.map((n) => (
				<Text key={n} color={theme.muted} wrap="wrap">
					· {n}
				</Text>
			))}

			{result ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color={result.ok ? theme.ok : theme.error}>
						{result.ok ? "✔ instalado" : "✖ parou num passo obrigatório"}
					</Text>
					{result.results.map((r) => (
						<Text
							key={r.step.cmd + r.step.args.join()}
							color={r.ok ? theme.muted : theme.error}
							wrap="truncate-end"
						>
							{r.ok ? "✔" : "✖"} {r.step.cmd} {r.step.args.join(" ")}
							{r.output ? ` — ${firstLine(r.output)}` : ""}
						</Text>
					))}
					{/* o primeiro passo que falhou é o que interrompeu tudo */}
					{(() => {
						const falho = result.results.find((r) => !r.ok && r.raw);
						return falho?.raw ? <ErrorBlock raw={falho.raw} /> : null;
					})()}
				</Box>
			) : null}

			{actionLog.length > 0 ? (
				<Box flexDirection="column" marginTop={1}>
					{actionLog.map((r) => (
						<Text
							key={r.step.cmd + r.step.args.join()}
							color={r.ok ? theme.ok : theme.error}
							wrap="truncate-end"
						>
							{r.ok ? "✔" : "✖"} {r.step.cmd} {r.step.args.join(" ")}
							{r.output ? ` — ${firstLine(r.output)}` : ""}
						</Text>
					))}
					{(() => {
						const falho = actionLog.find((r) => !r.ok && r.raw);
						return falho?.raw ? <ErrorBlock raw={falho.raw} /> : null;
					})()}
				</Box>
			) : null}
		</Box>
	);
}

function StatusPanel({
	status,
	width,
	availability,
	backend,
}: {
	status: ServiceStatus | null;
	width: number;
	availability: BackendAvailability[] | null;
	backend: Backend | null;
}) {
	const unavailable = availability?.find(
		(a) => a.backend === backend && !a.available,
	);

	return (
		<Box flexDirection="column">
			{status === null ? (
				<Text color={theme.muted}>—</Text>
			) : (
				<>
					<Text color={theme.accent} bold wrap="truncate-end">
						{status.name}
					</Text>
					<Box marginTop={1} flexDirection="column">
						<Stat
							label="instalado"
							value={status.installed ? "sim" : "não"}
							width={width}
							tone={status.installed ? "ok" : "muted"}
						/>
						<Stat
							label="rodando"
							value={status.running ? "sim" : "não"}
							width={width}
							tone={status.running ? "ok" : "muted"}
						/>
						<Stat
							label="no boot"
							value={status.enabled ? "sim" : "não"}
							width={width}
							tone={status.enabled ? "ok" : "muted"}
						/>
					</Box>
					{status.detail ? (
						<Box marginTop={1}>
							<Text color={theme.muted} wrap="wrap">
								{status.detail}
							</Text>
						</Box>
					) : null}
				</>
			)}

			{unavailable ? (
				<Box marginTop={1} flexDirection="column">
					<Text color={theme.warn} wrap="wrap">
						{unavailable.reason}
					</Text>
					{unavailable.fix ? (
						<Text color={theme.muted} wrap="wrap">
							{unavailable.fix}
						</Text>
					) : null}
				</Box>
			) : null}
		</Box>
	);
}

function firstLine(text: string): string {
	return text.split("\n")[0]?.slice(0, 80) ?? "";
}

/**
 * O erro cru do passo que falhou, em bloco e por inteiro (até `max` linhas).
 *
 * A lista de passos mostra uma linha por passo — que é o certo para ler o
 * plano, e inútil para entender uma falha: a causa do `docker compose` vem no
 * FIM do stderr, não no começo. Por isso o bloco começa pelo fim, que é onde a
 * mensagem mora, e a tela anuncia `ctrl+c` para levar o texto completo embora.
 */
function ErrorBlock({ raw, max = 10 }: { raw: string; max?: number }) {
	const linhas = raw
		.split("\n")
		.map((l) => l.trimEnd())
		.filter(Boolean);
	const cortou = linhas.length > max;
	const mostradas = cortou ? linhas.slice(-max) : linhas;

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text color={theme.error} bold>
				saída do comando{cortou ? ` (últimas ${max} linhas)` : ""}
			</Text>
			{mostradas.map((linha, i) => (
				<Text
					// biome-ignore lint/suspicious/noArrayIndexKey: linhas de um texto fixo, sem identidade própria
					key={i}
					color={theme.muted}
					wrap="wrap"
				>
					{linha}
				</Text>
			))}
			<Text color={theme.muted}>ctrl+c copia o erro inteiro</Text>
		</Box>
	);
}

/**
 * Ajuste manual da cerca de RAM/CPU do container.
 *
 * Três campos, `tab` entre eles, enter grava. Vale a tela própria porque os
 * números são acoplados: `mem_reservation` é alvo MACIO e precisa ficar abaixo
 * do `mem_limit`, que é teto duro — editar um sem ver o outro convida a
 * inverter os dois e produzir um compose que o Docker aceita e que não protege
 * nada.
 */
function ResourceEditor({
	initial,
	onSubmit,
	onCancel,
}: {
	initial: ResourceRec;
	onSubmit: (next: ResourceRec) => void;
	onCancel: () => void;
}) {
	const [limit, setLimit] = useState(String(initial.memLimitMiB));
	const [reserv, setReserv] = useState(String(initial.memReservMiB));
	const [cpu, setCpu] = useState(String(initial.cpus));
	const [field, setField] = useState<0 | 1 | 2>(0);

	const parsed = {
		memLimitMiB: numOr(limit, initial.memLimitMiB),
		memReservMiB: numOr(reserv, initial.memReservMiB),
		cpus: numOr(cpu, initial.cpus),
	};
	const invertido = parsed.memReservMiB > parsed.memLimitMiB;

	useInput((input, key) => {
		if (isMouseInput(input)) return;
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.tab) {
			setField((f) => ((f + 1) % 3) as 0 | 1 | 2);
			return;
		}
		if (key.return && !invertido) onSubmit(parsed);
	});

	const campos = [
		{ label: "mem_limit (MiB)", value: limit, set: setLimit },
		{ label: "mem_reservation (MiB)", value: reserv, set: setReserv },
		{ label: "cpus (aceita fração)", value: cpu, set: setCpu },
	];

	return (
		<Box flexDirection="column">
			<Text color={theme.border}>─ recursos do container ─</Text>
			{campos.map((c, i) => (
				<Box key={c.label} flexDirection="row">
					<Box width={24}>
						<Text color={i === field ? theme.accent : theme.muted}>
							{i === field ? "❯ " : "  "}
							{c.label}
						</Text>
					</Box>
					<TextInput
						value={c.value}
						onChange={c.set}
						focus={i === field}
						placeholder="—"
					/>
				</Box>
			))}
			{invertido ? (
				<Text color={theme.error} wrap="wrap">
					mem_reservation precisa ser MENOR que mem_limit: a reserva é um alvo
					macio, o limite é o teto duro que salva a VM.
				</Text>
			) : null}
			<Box marginTop={1}>
				<Text color={theme.muted}>
					tab campo · enter grava · esc cancela (volta ao recomendado)
				</Text>
			</Box>
		</Box>
	);
}

/** Number() seguro: devolve o fallback se vazio/NaN/não-positivo. */
function numOr(input: string, fallback: number): number {
	const n = Number(input.trim());
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
