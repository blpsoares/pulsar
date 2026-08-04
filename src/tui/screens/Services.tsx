import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { detectConfigs } from "../../core/compose/detectConfigs";
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
import { useTerminalSize } from "../hooks/useTerminalSize";
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
		() => (spec && backend ? buildPlan(backend, spec) : null),
		[spec, backend],
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
		if (busy) return;

		if (key.escape) {
			onExit();
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
			hints={[
				{ keys: "tab", label: "painel" },
				{ keys: "enter", label: "instalar" },
				{ keys: "i/p/t", label: "iniciar/parar/reiniciar" },
				{ keys: "x", label: "remover" },
				{ keys: "s", label: "boot" },
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
