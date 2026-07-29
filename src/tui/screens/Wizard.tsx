import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { emptyForm, type FormState } from "../../core/config/formState";
import type { CollectionEntryRaw } from "../../core/config/loadConfig";
import { formatBytes, formatCount } from "../../core/inspect/collStats";
import type { DbSummary } from "../../core/inspect/dbStats";
import type { TuiMode } from "../../core/inspect/summary";
import { buildTransferPlan } from "../../core/inspect/summary";
import { Select } from "../components/Select";
import {
	type Chip,
	type Hint,
	layout,
	Panel,
	Shell,
	SIDEBAR_WIDTH,
	Stat,
} from "../components/Shell";
import { useInspector } from "../hooks/useInspector";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { glyph, theme } from "../theme";
import { AdvancedStep } from "./wizard/AdvancedStep";
import { CollectionsStep } from "./wizard/CollectionsStep";
import { ConnectionStep } from "./wizard/ConnectionStep";
import {
	DEFAULT_ESTIMATE_OPTIONS,
	type EstimateOptions,
	EstimatesOptions,
} from "./wizard/EstimatesPanel";
import { ReviewStep } from "./wizard/ReviewStep";

/**
 * O wizard dentro do cockpit: trilho de passos na sidebar, passo atual no
 * centro, resumo do que está sendo montado à direita.
 *
 * A máquina de estados vive aqui e só aqui — cada passo é um componente burro
 * que recebe um pedaço do form e devolve o pedaço alterado. Foi isso que
 * permitiu, por exemplo, pular o passo de destino no modo ttl sem espalhar
 * `if (mode === 'ttl')` por cinco arquivos.
 */

type Step =
	| "mode"
	| "source"
	| "destination"
	| "collections"
	| "advanced"
	| "review";

const STEP_LABEL: Record<Step, string> = {
	mode: "modo",
	source: "origem",
	destination: "destino",
	collections: "collections",
	advanced: "avançado",
	review: "salvar",
};

const MODES: { value: TuiMode; label: string; hint: string }[] = [
	{
		value: "sync",
		label: "sync",
		hint: "réplica contínua (change stream, 24/7)",
	},
	{
		value: "migrate",
		label: "migrate",
		hint: "cópia pontual (mongodump/restore)",
	},
	{
		value: "ttl",
		label: "ttl",
		hint: "índices TTL em massa (não copia dados)",
	},
];

export function Wizard({
	initialForm,
	preserved,
	existingPath,
	onExit,
	onRun,
}: {
	initialForm?: FormState;
	preserved?: Map<string, CollectionEntryRaw>;
	existingPath?: string;
	onExit: () => void;
	onRun: (path: string) => void;
}) {
	const { columns, rows } = useTerminalSize();
	const l = layout(columns, rows);

	const [form, setForm] = useState<FormState>(initialForm ?? emptyForm("sync"));
	// Um yml aberto para edição já vem preenchido: começar na revisão evita
	// obrigar a percorrer o wizard inteiro para trocar uma linha.
	const [step, setStep] = useState<Step>(initialForm ? "review" : "mode");
	const [estimates, setEstimates] = useState<EstimateOptions>(
		DEFAULT_ESTIMATE_OPTIONS,
	);
	const [asideFocus, setAsideFocus] = useState(false);

	const source = useInspector();
	const destination = useInspector();
	const views = source.state.overview?.views ?? [];

	/**
	 * Config aberta para edição já traz URI e banco no arquivo — reconecta
	 * sozinha. Sem isto, voltar ao passo de collections mostraria uma lista
	 * vazia e o yml existente seria, na prática, não-editável: a origem só
	 * conectava quando alguém digitava a URI de novo.
	 */
	const autoConnected = useRef(false);
	useEffect(() => {
		if (autoConnected.current) return;
		const uri = initialForm?.source.uri;
		const db = initialForm?.source.db;
		if (!uri || !db) return;
		autoConnected.current = true;

		void (async () => {
			if (await source.connect(uri)) await source.loadDb(db);
		})();
	}, [initialForm, source]);

	const order = stepOrder(form.mode);
	const index = order.indexOf(step);

	function back() {
		if (index <= 0) onExit();
		else setStep(order[index - 1] as Step);
	}

	function next() {
		setStep((order[index + 1] ?? "review") as Step);
	}

	const plan = buildTransferPlan({
		mode: form.mode,
		selected: form.collections,
		estimates: source.state.estimates,
		indexes: source.state.indexes,
		sourceViews: views,
		copyIndexes: form.copyIndexes,
		copyViews: form.copyViews,
	});

	function inspectorFor(current: Step) {
		return current === "destination" ? destination : source;
	}

	const chips: Chip[] = [
		{ label: "modo", value: form.mode },
		{
			label: "passo",
			value: `${index + 1}/${order.length} ${STEP_LABEL[step]}`,
			tone: "muted",
		},
	];
	if (form.source.db)
		chips.push({
			label: "origem",
			value: form.source.db,
			tone: source.state.status === "connected" ? "ok" : "muted",
		});
	if (form.mode !== "ttl" && form.destination.db)
		chips.push({ label: "destino", value: form.destination.db, tone: "muted" });

	return (
		<Shell
			chips={chips}
			columns={columns}
			rows={rows}
			hints={hintsFor(step, asideFocus)}
		>
			<Box flexDirection="column" width={SIDEBAR_WIDTH}>
				<Panel title="passos" width={SIDEBAR_WIDTH} height={order.length + 3}>
					{order.map((s, i) => (
						<Text
							key={s}
							color={
								s === step ? theme.accent : i < index ? theme.ok : theme.muted
							}
							bold={s === step}
						>
							{s === step ? "▍" : " "}
							{i < index ? glyph.checked : s === step ? "◈" : glyph.unchecked}{" "}
							{STEP_LABEL[s]}
						</Text>
					))}
				</Panel>

				{step === "collections" ? (
					<Panel
						title="números"
						width={SIDEBAR_WIDTH}
						focused={asideFocus}
						grow
					>
						<EstimatesOptions
							options={estimates}
							onChange={setEstimates}
							onClose={() => setAsideFocus(false)}
							focused={asideFocus}
							loading={source.state.loadingStats}
						/>
					</Panel>
				) : (
					<Panel title="config" width={SIDEBAR_WIDTH} grow>
						<Text color={theme.muted} wrap="wrap">
							{describeMode(form.mode)}
						</Text>
					</Panel>
				)}
			</Box>

			<Panel
				title={STEP_LABEL[step]}
				width={l.center}
				height={l.body}
				focused={!asideFocus}
			>
				{step === "mode" ? (
					<Box flexDirection="column">
						<Text color={theme.muted}>o que este arquivo vai fazer?</Text>
						<Box marginTop={1}>
							<Select
								items={MODES.map((m) => ({
									value: m.value,
									label: m.label,
									hint: m.hint,
								}))}
								onSelect={(mode) => {
									setForm((f) => ({ ...f, mode }));
									setStep("source");
								}}
								initialIndex={MODES.findIndex((m) => m.value === form.mode)}
							/>
						</Box>
					</Box>
				) : null}

				{step === "source" ? (
					<ConnectionStep
						kind="source"
						uri={form.source.uri}
						db={form.source.db}
						onChange={(source) => setForm((f) => ({ ...f, source }))}
						inspector={source}
						onDone={next}
						onBack={back}
					/>
				) : null}

				{step === "destination" ? (
					<ConnectionStep
						kind="destination"
						uri={form.destination.uri}
						db={form.destination.db}
						onChange={(destination) => setForm((f) => ({ ...f, destination }))}
						inspector={destination}
						onDone={next}
						onBack={back}
					/>
				) : null}

				{step === "collections" ? (
					<CollectionsStep
						dbName={form.source.db}
						selected={form.collections}
						onChange={(collections) => setForm((f) => ({ ...f, collections }))}
						inspector={source}
						options={estimates}
						onOpenEstimates={() => setAsideFocus(true)}
						onDone={next}
						onBack={back}
						focused={!asideFocus}
						visibleRows={l.panelRows - 2}
					/>
				) : null}

				{step === "advanced" ? (
					<AdvancedStep
						form={form}
						onChange={setForm}
						views={views}
						onDone={next}
						onBack={back}
					/>
				) : null}

				{step === "review" ? (
					<ReviewStep
						form={form}
						preserved={preserved}
						existingPath={existingPath}
						previewRows={l.panelRows - 6}
						onSaved={(path, action) =>
							action === "run" ? onRun(path) : onExit()
						}
						onBack={back}
					/>
				) : null}
			</Panel>

			{l.aside > 0 ? (
				showDbPanel(step) ? (
					<Panel title="banco" width={l.aside} height={l.body}>
						<DbPanel
							width={l.aside}
							summary={inspectorFor(step).state.summary}
							connecting={inspectorFor(step).state.status === "connecting"}
							// o banco EXIBIDO é o que está carregado (o cursor da lista já
							// dispara o preview), não o que já foi confirmado no form
							dbName={
								inspectorFor(step).state.currentDb ??
								(step === "destination" ? form.destination.db : form.source.db)
							}
							collections={
								inspectorFor(step).state.overview?.collections.map(
									(c) => c.name,
								) ?? []
							}
							views={inspectorFor(step).state.overview?.views.length ?? 0}
						/>
					</Panel>
				) : (
					<Panel title="vai ser enviado" width={l.aside} height={l.body}>
						<PlanPanel
							plan={plan}
							width={l.aside}
							showNumbers={estimates.enabled}
							totalCollections={source.state.overview?.collections.length ?? 0}
						/>
					</Panel>
				)
			) : null}
		</Shell>
	);
}

/**
 * Retrato do banco assim que a conexão é aceita: o que existe lá dentro, antes
 * de escolher qualquer coisa. Vem de UMA chamada `dbStats` (metadata), então
 * aparece junto com a lista de collections e não custa varredura.
 */
function DbPanel({
	width,
	summary,
	connecting,
	dbName,
	collections,
	views,
}: {
	width: number;
	summary?: DbSummary;
	connecting: boolean;
	dbName: string;
	collections: string[];
	views: number;
}) {
	if (connecting) return <Text color={theme.muted}>conectando…</Text>;
	if (!dbName)
		return (
			<Text color={theme.muted} wrap="wrap">
				informe a connection string para ver o que existe no banco
			</Text>
		);
	if (!summary)
		return <Text color={theme.muted}>escolha o banco para ver o resumo</Text>;

	if (summary.error)
		return (
			<Box flexDirection="column">
				<Text color={theme.warn} wrap="wrap">
					sem permissão para ler as estatísticas deste banco
				</Text>
				<Box marginTop={1}>
					<Stat
						label="collections"
						value={String(collections.length)}
						width={width}
					/>
				</Box>
			</Box>
		);

	// Amostra de nomes: dá para reconhecer o banco de relance, sem sair da tela.
	const sample = collections.slice(0, 6);

	return (
		<Box flexDirection="column">
			<Text color={theme.accent} bold wrap="truncate-end">
				{dbName}
			</Text>
			<Box marginTop={1} flexDirection="column">
				{/*
				 * collections e views vêm da LISTA, não do dbStats: o dbStats conta
				 * `system.views` como collection, e o número na tela tem que bater
				 * com o que dá para selecionar no passo seguinte.
				 */}
				<Stat
					label="collections"
					value={String(collections.length)}
					width={width}
					tone="ok"
				/>
				<Stat label="views" value={String(views)} width={width} />
				<Stat label="índices" value={String(summary.indexes)} width={width} />
				<Stat
					label="docs"
					value={`~${formatCount(summary.objects)}`}
					width={width}
				/>
				<Stat
					label="dados"
					value={formatBytes(summary.dataSize)}
					width={width}
				/>
				<Stat
					label="em disco"
					value={formatBytes(summary.storageSize)}
					width={width}
					tone="muted"
				/>
				<Stat
					label="idx disco"
					value={formatBytes(summary.indexSize)}
					width={width}
					tone="muted"
				/>
			</Box>

			{sample.length > 0 ? (
				<Box marginTop={1} flexDirection="column">
					<Text color={theme.border}>─ collections ─</Text>
					{sample.map((name) => (
						<Text key={name} color={theme.muted} wrap="truncate-end">
							{name}
						</Text>
					))}
					{collections.length > sample.length ? (
						<Text color={theme.border}>
							…e mais {collections.length - sample.length}
						</Text>
					) : null}
				</Box>
			) : null}
		</Box>
	);
}

/** Passos de conexão mostram o BANCO; os demais, o que será enviado. */
function showDbPanel(step: Step): boolean {
	return step === "mode" || step === "source" || step === "destination";
}

function PlanPanel({
	plan,
	width,
	showNumbers,
	totalCollections,
}: {
	plan: ReturnType<typeof buildTransferPlan>;
	width: number;
	showNumbers: boolean;
	totalCollections: number;
}) {
	const approx = plan.approximate ? "~" : "";

	return (
		<Box flexDirection="column">
			<Stat
				label="colls"
				value={`${plan.collections}/${totalCollections || plan.collections}`}
				width={width}
				tone={plan.collections > 0 ? "ok" : "warn"}
			/>
			{showNumbers ? (
				<>
					<Stat
						label="docs"
						value={`${approx}${formatCount(plan.docs)}`}
						width={width}
					/>
					<Stat
						label="tamanho"
						value={`${approx}${formatBytes(plan.dataSize)}`}
						width={width}
					/>
				</>
			) : null}
			<Stat label="índices" value={String(plan.indexes)} width={width} />
			<Stat label="views" value={String(plan.views)} width={width} />

			{showNumbers && plan.approximate ? (
				<Box marginTop={1}>
					<Text color={theme.muted} wrap="wrap">
						~ é estimativa de metadata. `c` conta a collection sob o cursor de
						verdade.
					</Text>
				</Box>
			) : null}

			{plan.warnings.length > 0 ? (
				<Box marginTop={1} flexDirection="column">
					{plan.warnings.map((w) => (
						<Text key={w} color={theme.warn} wrap="wrap">
							⚠ {w}
						</Text>
					))}
				</Box>
			) : null}
		</Box>
	);
}

/** ttl opera num banco só — o passo de destino simplesmente não existe nele. */
function stepOrder(mode: TuiMode): Step[] {
	const order: Step[] = [
		"mode",
		"source",
		"destination",
		"collections",
		"advanced",
		"review",
	];
	return mode === "ttl" ? order.filter((s) => s !== "destination") : order;
}

function describeMode(mode: TuiMode): string {
	if (mode === "sync")
		return "réplica contínua: dump inicial e change stream daí em diante.";
	if (mode === "migrate")
		return "cópia pontual via mongodump/mongorestore. índices vão junto.";
	return "cria índices TTL nas collections escolhidas. não copia dados.";
}

function hintsFor(step: Step, asideFocus: boolean): Hint[] {
	if (asideFocus)
		return [
			{ keys: "↑↓", label: "navegar" },
			{ keys: "espaço", label: "marcar" },
			{ keys: "esc", label: "voltar à lista" },
		];

	switch (step) {
		case "mode":
			return [
				{ keys: "↑↓", label: "navegar" },
				{ keys: "enter", label: "escolher" },
				{ keys: "esc", label: "sair" },
			];
		case "source":
		case "destination":
			return [
				{ keys: "enter", label: "conectar/confirmar" },
				{ keys: "tab", label: "trocar campo" },
				{ keys: "esc", label: "voltar" },
			];
		case "collections":
			return [
				{ keys: "espaço", label: "marcar" },
				{ keys: "/", label: "buscar" },
				{ keys: "a/n", label: "todas/nenhuma" },
				{ keys: "c", label: "contar exato" },
				{ keys: "e", label: "estimativas" },
				{ keys: "enter", label: "seguir" },
				{ keys: "esc", label: "voltar" },
			];
		case "advanced":
			return [
				{ keys: "espaço", label: "ligar/desligar" },
				{ keys: "enter", label: "editar/seguir" },
				{ keys: "v", label: "views" },
				{ keys: "esc", label: "voltar" },
			];
		case "review":
			return [
				{ keys: "enter", label: "salvar" },
				{ keys: "r", label: "salvar e rodar" },
				{ keys: "e", label: "nome do arquivo" },
				{ keys: "esc", label: "voltar" },
			];
	}
}
