import { relative, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { detectConfigs } from "../../core/compose/detectConfigs";
import { buildConfig } from "../../core/config/buildConfig";
import { emptyForm, type FormState } from "../../core/config/formState";
import {
	type CollectionEntryRaw,
	loadConfigFile,
} from "../../core/config/loadConfig";
import {
	suggestFileName,
	validateConfig,
	writeConfigFile,
} from "../../core/config/writeConfig";
import { maskUri } from "../../core/inspect/maskUri";
import type { TuiMode } from "../../core/inspect/summary";
import type { RunMode } from "../../core/run/pulsarCommand";
import {
	type BackendAvailability,
	detectBackends,
	preferredBackend,
} from "../../core/service/detect";
import {
	buildPlan,
	type InstallResult,
	installService,
} from "../../core/service/manager";
import { detectSudo, type SudoMode } from "../../core/service/privileged";
import type {
	Backend,
	ServiceSpec,
	ServiceStep,
} from "../../core/service/types";
import {
	CREATED_BY_TUI,
	type ServiceRecord,
	writeRecord,
} from "../../core/state/registry";
import { Overlay } from "../components/Overlay";
import { Select } from "../components/Select";
import { Stat } from "../components/Shell";
import { TextInput } from "../components/TextInput";
import { useInspector } from "../hooks/useInspector";
import { overlayBox } from "../layout";
import { useClickable } from "../mouse/MouseProvider";
import { isMouseInput } from "../mouse/parse";
import { theme } from "../theme";
import {
	FIELD_LABEL,
	type FieldId,
	fieldNeedsDestination,
	fieldNeedsSource,
	formatCommaList,
	formatIndexesList,
	needsSudo,
	parseCommaList,
	parseIndexesList,
	visibleFields,
} from "./serviceFormFields";
import { CollectionsStep } from "./wizard/CollectionsStep";
import { DEFAULT_ESTIMATE_OPTIONS } from "./wizard/EstimatesPanel";
import { IndexesStep } from "./wizard/IndexesStep";
import { ViewsStep } from "./wizard/ViewsStep";

/**
 * O formulário único de criação/edição de serviço.
 *
 * Substitui o wizard passo-a-passo: NENHUM campo depende de atravessar os
 * outros para ser alcançado. `↑↓` anda entre os 12 campos possíveis (menos os
 * que o MODO exclui estruturalmente — ver `visibleFields`), `enter` abre o
 * editor daquele campo, e fechar o editor (`enter`/`esc` de novo) volta
 * exatamente para a mesma linha. Trocar o destino de um yml existente é UM
 * campo de distância, não três telas.
 *
 * Campo que depende de conexão (origem.db, collections, views, índices) NUNCA
 * desaparece: fica esmaecido com o motivo ao lado, e continua abrível — sem
 * conexão, `enter` abre um campo de texto livre (nomes separados por vírgula)
 * em vez do picker.
 */

export type ServiceDraft = {
	name: string;
	mode: RunMode;
	configPath: string;
	form: FormState;
	backend: Backend;
	boot: boolean;
};

/** Sentinela do item "gravar um yml novo" na lista de configs. */
const HERE = "\u0000here";

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

/** Campos cujo editor pode crescer bastante (busca + lista grande) — ocupam o painel sozinhos. */
function isWideField(id: FieldId): id is "collections" | "views" | "indexes" {
	return id === "collections" || id === "views" || id === "indexes";
}

export function ServiceForm({
	dir,
	initial,
	columns,
	rows,
	onCancel,
	onSubmit,
}: {
	dir: string;
	initial?: ServiceRecord;
	columns: number;
	rows: number;
	onCancel: () => void;
	onSubmit: (draft: ServiceDraft, andStart: boolean) => void;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [mode, setMode] = useState<TuiMode>(initial?.mode ?? "sync");
	// Exibido/comparado sempre RELATIVO a `dir` (mesmo formato que `detectConfigs`
	// devolve) — só vira absoluto na hora de ler/gravar o arquivo de verdade
	// (`resolve`, logo abaixo e em `submit`). `initial.config` já chega absoluto
	// (é o que `writeConfigFile` grava no registro).
	const [configPath, setConfigPath] = useState(
		initial?.config ? relative(dir, initial.config) || initial.config : "",
	);
	const [form, setForm] = useState<FormState>(emptyForm(mode));
	const [preserved, setPreserved] = useState<Map<string, CollectionEntryRaw>>();
	const [backend, setBackend] = useState<Backend>(
		initial?.backend ?? "systemd",
	);
	const [boot, setBoot] = useState(initial?.boot ?? false);

	const [availability, setAvailability] = useState<
		BackendAvailability[] | null
	>(null);
	const configs = useMemo(
		() =>
			detectConfigs(dir, { recursive: true }).filter(
				(c) => c.kind !== "desconhecido",
			),
		[dir],
	);

	const [cursor, setCursor] = useState(0);
	const [editing, setEditing] = useState<FieldId | null>(null);
	const [textBuf, setTextBuf] = useState("");
	const [loadError, setLoadError] = useState<string | null>(null);
	const [submitErrors, setSubmitErrors] = useState<string[]>([]);

	// Instalação em curso — enquanto isto não é null, o teclado da lista de
	// campos fica desligado (só a confirmação de sudo ou o relatório final
	// escutam).
	const [installing, setInstalling] = useState(false);
	const [askStep, setAskStep] = useState<ServiceStep | null>(null);
	const askResolver = useRef<((ok: boolean) => void) | null>(null);
	const [pending, setPending] = useState<{
		skipped: ServiceStep[];
		manual: { step: ServiceStep; ok: boolean; output: string }[];
		draft: ServiceDraft;
		andStart: boolean;
	} | null>(null);

	const source = useInspector();
	const destination = useInspector();

	// Um yml existente (edição de serviço, ou config escolhida na lista) carrega
	// sozinho — sem isto, os campos de origem/destino ficariam vazios e a
	// "edição" seria só de nome/backend/boot.
	const loadedOnce = useRef(false);
	useEffect(() => {
		if (loadedOnce.current || !initial?.config) return;
		loadedOnce.current = true;
		const loaded = loadConfigFile(initial.config);
		if (!loaded) {
			setLoadError(`não consegui ler ${initial.config} como config do pulsar`);
			return;
		}
		setForm(loaded.form);
		setMode(loaded.form.mode);
		setPreserved(loaded.preservedEntries);
	}, [initial]);

	// Reconecta sozinho quando o form já tem URI+db (yml carregado) — mesmo
	// motivo do Wizard: sem isso, abrir um serviço existente para editar
	// mostraria collections/views/índices vazios mesmo já sincronizando.
	const autoConnected = useRef(false);
	useEffect(() => {
		if (autoConnected.current) return;
		if (!form.source.uri || !form.source.db) return;
		autoConnected.current = true;
		void (async () => {
			if (await source.connect(form.source.uri))
				await source.loadDb(form.source.db);
		})();
	}, [form.source.uri, form.source.db, source]);

	const autoConnectedDest = useRef(false);
	useEffect(() => {
		if (autoConnectedDest.current) return;
		if (!form.destination.uri || !form.destination.db) return;
		autoConnectedDest.current = true;
		void (async () => {
			if (await destination.connect(form.destination.uri))
				await destination.loadDb(form.destination.db);
		})();
	}, [form.destination.uri, form.destination.db, destination]);

	useEffect(() => {
		void detectBackends(dir).then((a) => {
			setAvailability(a);
			// Só sugere um backend sozinho quando é um serviço NOVO — editar um
			// serviço existente não pode trocar o backend por baixo dos pés dele.
			if (!initial) setBackend((b) => preferredBackend(a) ?? b);
		});
	}, [dir, initial]);

	const sourceConnected = source.state.status === "connected";
	const destConnected = destination.state.status === "connected";

	const fields = useMemo(() => visibleFields(mode), [mode]);
	const cur = Math.min(cursor, Math.max(0, fields.length - 1));
	const currentField = fields[cur];

	function updateForm(patch: Partial<FormState>) {
		setForm((f) => ({ ...f, ...patch }));
	}

	function openEditor(field: FieldId) {
		setSubmitErrors([]);
		if (field === "collections" && !sourceConnected)
			setTextBuf(formatCommaList(form.collections));
		if (field === "views" && !sourceConnected)
			setTextBuf(
				typeof form.copyViews === "boolean"
					? ""
					: formatCommaList(form.copyViews),
			);
		if (field === "indexes" && !sourceConnected)
			setTextBuf(formatIndexesList(form.copyIndexes));
		setEditing(field);
	}

	function closeEditor() {
		setEditing(null);
	}

	function toggleBoot() {
		setBoot((b) => !b);
	}

	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (askStep || installing || pending) return;
			if (editing) return; // o editor do campo é quem escuta

			if (key.escape) {
				onCancel();
				return;
			}
			if (key.upArrow) {
				setCursor((c) => Math.max(0, c - 1));
				return;
			}
			if (key.downArrow) {
				setCursor((c) => Math.min(fields.length - 1, c + 1));
				return;
			}
			if (input === " ") {
				if (currentField === "boot") toggleBoot();
				return;
			}
			if (key.return) {
				if (!currentField) return;
				if (currentField === "boot") toggleBoot();
				else openEditor(currentField);
				return;
			}
			if (key.ctrl && input === "s") {
				void submit(true);
				return;
			}
			if (key.ctrl && input === "o") {
				void submit(false);
				return;
			}
		},
		{ isActive: true },
	);

	// `esc` fecha o editor dos campos COMPACTOS (TextInput, Select não tratam
	// escape sozinhos). Os campos LARGOS (collections/views/índices) ficam de
	// fora de propósito: o picker tem um modo de busca próprio em que `esc`
	// significa "sair da busca", não "fechar o campo" — um handler genérico
	// aqui fecharia o editor por baixo do usuário no meio de uma busca.
	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (!editing || isWideField(editing)) return;
			if (key.escape) closeEditor();
		},
		{ isActive: Boolean(editing) },
	);

	// Confirmação de sudo: "vou rodar: <comando> — enter digita a senha / p pula".
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

	// Relatório final (pendências) — enter/esc fecham e entregam ao chamador.
	useInput(
		(_input, key) => {
			if (!pending) return;
			if (key.return || key.escape) {
				const { draft, andStart } = pending;
				setPending(null);
				onSubmit(draft, andStart);
			}
		},
		{ isActive: Boolean(pending) },
	);

	async function ask(step: ServiceStep): Promise<boolean> {
		return new Promise((finish) => {
			askResolver.current = finish;
			setAskStep(step);
		});
	}

	async function submit(andStart: boolean) {
		const config = buildConfig(form, preserved);
		const errors = validateConfig(mode, config);
		if (errors.length > 0) {
			setSubmitErrors(errors);
			return;
		}

		// `configPath` é relativo a `dir` (mesmo formato de `detectConfigs`);
		// vazio significa "— definir aqui —", e o pulsar escolhe um nome livre.
		const target = resolve(
			dir,
			configPath ||
				suggestFileName(mode, form.destination.db || form.source.db, dir),
		);

		const written = writeConfigFile(target, mode, config);
		if (!written.ok) {
			setSubmitErrors(written.errors);
			return;
		}
		setConfigPath(relative(dir, written.path) || written.path);

		const draft: ServiceDraft = {
			name,
			mode: mode as RunMode,
			configPath: written.path,
			form,
			backend,
			boot,
		};

		if (!andStart) {
			writeRecord(recordFor(draft, initial));
			onSubmit(draft, false);
			return;
		}

		const spec: ServiceSpec = {
			name,
			mode: mode as RunMode,
			configPath: written.path,
			workingDir: dir,
			autostart: boot,
		};

		const plan = buildPlan(backend, spec);
		if ("error" in plan) {
			setSubmitErrors([plan.error]);
			return;
		}

		setInstalling(true);
		const sudo: SudoMode = await detectSudo();
		const result: InstallResult = await installService(plan, spec, {
			sudo,
			ask,
		});
		setInstalling(false);

		// `boot: false` gravado quando algum passo com sudo foi recusado — o boot
		// REALMENTE não ficou habilitado, e o registro tem que descrever a
		// realidade, não uma promessa. Não existe campo "pendente": ou está
		// ligado, ou não está.
		const finalBoot = boot && result.skippedPrivileged.length === 0;
		const finalDraft: ServiceDraft = { ...draft, boot: finalBoot };
		writeRecord(recordFor(finalDraft, initial));

		// Passo manual que RODOU mas só imprimiu instrução (ex.: `pm2 startup`,
		// que é `privileged: true` sem precisar de sudo de verdade) também entra
		// no relatório — `ok: true` ali não quer dizer "boot pronto".
		const manual = result.results
			.filter((r) => plan.manualSteps.includes(r.step))
			.map((r) => ({ step: r.step, ok: r.ok, output: r.output }));

		if (result.skippedPrivileged.length > 0 || manual.length > 0) {
			setPending({
				skipped: result.skippedPrivileged,
				manual,
				draft: finalDraft,
				andStart: true,
			});
			return;
		}

		onSubmit(finalDraft, true);
	}

	const box = overlayBox(columns, rows);
	const innerWidth = Math.max(20, box.width - 4);

	if (askStep) {
		return (
			<Overlay title="confirmar comando" columns={columns} rows={rows}>
				<Text color={theme.muted} wrap="wrap">
					vou rodar (pede senha):
				</Text>
				<Text color={theme.label} wrap="wrap">
					{askStep.cmd} {askStep.args.join(" ")}
				</Text>
				<Text color={theme.muted} wrap="wrap">
					{askStep.why}
				</Text>
				<Box marginTop={1}>
					<Text>
						<Text color={theme.accent} bold>
							enter
						</Text>
						<Text color={theme.muted}> digitar a senha agora · </Text>
						<Text color={theme.accent} bold>
							p
						</Text>
						<Text color={theme.muted}> pular</Text>
					</Text>
				</Box>
			</Overlay>
		);
	}

	if (installing)
		return (
			<Overlay title="instalando" columns={columns} rows={rows}>
				<Text color={theme.muted}>gravando arquivos e rodando os passos…</Text>
			</Overlay>
		);

	if (pending)
		return (
			<Overlay title="ficou pendente" columns={columns} rows={rows}>
				{pending.skipped.length > 0 ? (
					<Box flexDirection="column" marginBottom={1}>
						<Text color={theme.warn}>─ pulados (sudo recusado) ─</Text>
						{pending.skipped.map((s) => (
							<Text key={s.cmd + s.args.join()} wrap="wrap">
								<Text color={theme.warn}>
									{s.cmd} {s.args.join(" ")}
								</Text>
								<Text color={theme.muted}> — {s.why}</Text>
							</Text>
						))}
					</Box>
				) : null}
				{pending.manual.length > 0 ? (
					<Box flexDirection="column">
						<Text color={theme.warn}>─ passos manuais (confira a saída) ─</Text>
						{pending.manual.map((m) => (
							<Box key={m.step.cmd + m.step.args.join()} flexDirection="column">
								<Text wrap="wrap">
									<Text color={m.ok ? theme.ok : theme.error}>
										{m.ok ? "✔" : "✖"}
									</Text>{" "}
									<Text color={theme.label}>
										{m.step.cmd} {m.step.args.join(" ")}
									</Text>
									<Text color={theme.muted}> — {m.step.why}</Text>
								</Text>
								{m.output ? (
									<Text color={theme.muted} wrap="wrap">
										{"  "}
										{m.output.split("\n").slice(-4).join("\n  ")}
									</Text>
								) : null}
							</Box>
						))}
					</Box>
				) : null}
				<Box marginTop={1}>
					<Text color={theme.border}>enter/esc fecha</Text>
				</Box>
			</Overlay>
		);

	return (
		<Overlay
			title={name || "novo serviço"}
			columns={columns}
			rows={rows}
			footer={
				submitErrors.length > 0 || loadError ? (
					<Box flexDirection="column">
						{loadError ? <Text color={theme.error}>{loadError}</Text> : null}
						{submitErrors.map((e) => (
							<Text key={e} color={theme.error} wrap="wrap">
								✖ {e}
							</Text>
						))}
					</Box>
				) : undefined
			}
		>
			{editing && isWideField(editing) ? (
				<WideEditor
					field={editing}
					form={form}
					sourceConnected={sourceConnected}
					source={source}
					textBuf={textBuf}
					setTextBuf={setTextBuf}
					updateForm={updateForm}
					onDone={closeEditor}
				/>
			) : (
				<Box flexDirection="column">
					{fields.map((id, i) => (
						<FieldRow
							key={id}
							id={id}
							active={i === cur}
							editing={editing === id}
							width={innerWidth}
							name={name}
							setName={setName}
							mode={mode}
							setMode={(m) => {
								setMode(m);
								updateForm({ mode: m });
								closeEditor();
							}}
							configPath={configPath}
							configs={configs}
							onSelectConfig={(value) => {
								closeEditor();
								if (value === HERE) {
									setConfigPath("");
									return;
								}
								// `value` já vem relativo a `dir` (é como `detectConfigs`
								// devolve) — só precisa virar absoluto para LER o arquivo.
								const loaded = loadConfigFile(resolve(dir, value));
								if (!loaded) {
									setConfigPath(value);
									setLoadError(
										`não consegui ler ${value} como config do pulsar`,
									);
									return;
								}
								setConfigPath(value);
								setForm(loaded.form);
								setMode(loaded.form.mode);
								setPreserved(loaded.preservedEntries);
								setLoadError(null);
							}}
							form={form}
							updateForm={updateForm}
							source={source}
							destination={destination}
							sourceConnected={sourceConnected}
							destConnected={destConnected}
							textBuf={textBuf}
							setTextBuf={setTextBuf}
							backend={backend}
							setBackend={(b) => {
								setBackend(b);
								closeEditor();
							}}
							availability={availability}
							boot={boot}
							onOpen={() => {
								setCursor(i);
								if (id === "boot") toggleBoot();
								else openEditor(id);
							}}
							onCloseEditor={closeEditor}
						/>
					))}
				</Box>
			)}
		</Overlay>
	);
}

function recordFor(
	draft: ServiceDraft,
	initial?: ServiceRecord,
): ServiceRecord {
	return {
		name: draft.name,
		mode: draft.mode,
		config: draft.configPath,
		workingDir: initial?.workingDir ?? process.cwd(),
		backend: draft.backend,
		boot: draft.boot,
		createdBy: initial?.createdBy ?? CREATED_BY_TUI,
		lastRun: initial?.lastRun ?? null,
	};
}

/** Um editor "largo" (busca + lista grande) ocupa o painel inteiro enquanto aberto. */
function WideEditor({
	field,
	form,
	sourceConnected,
	source,
	textBuf,
	setTextBuf,
	updateForm,
	onDone,
}: {
	field: "collections" | "views" | "indexes";
	form: FormState;
	sourceConnected: boolean;
	source: ReturnType<typeof useInspector>;
	textBuf: string;
	setTextBuf: (v: string) => void;
	updateForm: (patch: Partial<FormState>) => void;
	onDone: () => void;
}) {
	if (!sourceConnected) {
		const placeholder =
			field === "indexes"
				? "collection.índice, collection.índice2"
				: "coll1, coll2";
		return (
			<Box flexDirection="column">
				<Text color={theme.muted} wrap="wrap">
					sem conexão com a origem — digite os nomes separados por vírgula
					{field === "indexes" ? " (formato collection.índice)" : ""}.
				</Text>
				<Box marginTop={1}>
					<TextInput
						value={textBuf}
						onChange={setTextBuf}
						onSubmit={() => {
							if (field === "collections")
								updateForm({ collections: parseCommaList(textBuf) });
							else if (field === "views")
								updateForm({ copyViews: parseCommaList(textBuf) });
							else updateForm({ copyIndexes: parseIndexesList(textBuf) });
							onDone();
						}}
						focus
						placeholder={placeholder}
					/>
				</Box>
				<Box marginTop={1}>
					<Text color={theme.border}>enter confirma · esc volta</Text>
				</Box>
			</Box>
		);
	}

	if (field === "collections")
		return (
			<CollectionsStep
				dbName={form.source.db}
				selected={form.collections}
				onChange={(collections) => updateForm({ collections })}
				inspector={source}
				options={DEFAULT_ESTIMATE_OPTIONS}
				onOpenEstimates={() => {}}
				onDone={onDone}
				onBack={onDone}
				focused
				visibleRows={10}
			/>
		);

	if (field === "views")
		return (
			<ViewsStep
				views={source.state.overview?.views ?? []}
				value={form.copyViews}
				selectedCollections={form.collections}
				onChange={(copyViews) => updateForm({ copyViews })}
				onDone={onDone}
				onBack={onDone}
				focused
				visibleRows={10}
			/>
		);

	return (
		<IndexesStep
			dbName={form.source.db}
			collections={form.collections}
			value={form.copyIndexes}
			onChange={(copyIndexes) => updateForm({ copyIndexes })}
			inspector={source}
			onDone={onDone}
			onBack={onDone}
			focused
			visibleRows={10}
		/>
	);
}

/** Valor sentinela do item "digitar outro nome" no Select de banco. */
const TYPE_NEW = "\u0000novo";

function FieldRow(props: {
	id: FieldId;
	active: boolean;
	editing: boolean;
	width: number;
	name: string;
	setName: (v: string) => void;
	mode: TuiMode;
	setMode: (m: TuiMode) => void;
	configPath: string;
	configs: { file: string; kind: string }[];
	onSelectConfig: (value: string) => void;
	form: FormState;
	updateForm: (patch: Partial<FormState>) => void;
	source: ReturnType<typeof useInspector>;
	destination: ReturnType<typeof useInspector>;
	sourceConnected: boolean;
	destConnected: boolean;
	textBuf: string;
	setTextBuf: (v: string) => void;
	backend: Backend;
	setBackend: (b: Backend) => void;
	availability: BackendAvailability[] | null;
	boot: boolean;
	onOpen: () => void;
	onCloseEditor: () => void;
}) {
	const { id, active, editing, width } = props;

	const ref = useClickable({ onClick: props.onOpen });

	if (editing) {
		return (
			<Box ref={ref} flexDirection="column" marginBottom={1}>
				<Text color={theme.accent}>{FIELD_LABEL[id]}</Text>
				<EditorFor {...props} />
			</Box>
		);
	}

	const { value, tone, reason } = displayFor(props);

	return (
		<Box ref={ref}>
			<Stat
				label={`${active ? "❯ " : "  "}${FIELD_LABEL[id]}`}
				value={reason ? `${value}  ${reason}` : value}
				width={width}
				tone={tone}
			/>
		</Box>
	);
}

function displayFor(props: {
	id: FieldId;
	name: string;
	mode: TuiMode;
	configPath: string;
	form: FormState;
	sourceConnected: boolean;
	destConnected: boolean;
	backend: Backend;
	boot: boolean;
}): {
	value: string;
	tone?: "ok" | "warn" | "error" | "muted";
	reason?: string;
} {
	const {
		id,
		name,
		mode,
		configPath,
		form,
		sourceConnected,
		destConnected,
		backend,
		boot,
	} = props;

	// Motivo do campo esmaecido, quando aplicável — a MESMA regra que decide se
	// o editor abre um picker de verdade ou um texto livre (ver `EditorFor`),
	// centralizada em `fieldNeedsSource`/`fieldNeedsDestination` para as duas
	// pontas nunca discordarem sobre qual campo depende de qual conexão.
	const reason =
		fieldNeedsSource(id) && !sourceConnected
			? "informe a origem para listar"
			: fieldNeedsDestination(id) && !destConnected
				? "informe o destino para listar"
				: undefined;

	switch (id) {
		case "name":
			return { value: name || "—", tone: name ? undefined : "muted" };
		case "mode":
			return { value: mode };
		case "config":
			return {
				value: configPath || "— definir aqui —",
				tone: configPath ? "muted" : undefined,
			};
		case "sourceUri":
			return {
				value: form.source.uri ? maskUri(form.source.uri) : "—",
				tone: form.source.uri ? undefined : "muted",
			};
		case "sourceDb":
			return {
				value: form.source.db || "—",
				tone: form.source.db ? undefined : "muted",
				reason,
			};
		case "destUri":
			return {
				value: form.destination.uri ? maskUri(form.destination.uri) : "—",
				tone: form.destination.uri ? undefined : "muted",
			};
		case "destDb":
			return {
				value: form.destination.db || "—",
				tone: form.destination.db ? undefined : "muted",
				reason,
			};
		case "collections":
			return {
				value:
					form.collections.length > 0
						? `${form.collections.length} marcadas`
						: "—",
				tone: form.collections.length > 0 ? "ok" : "muted",
				reason,
			};
		case "views": {
			const viewCount = Array.isArray(form.copyViews)
				? form.copyViews.length
				: 0;
			return {
				value:
					form.copyViews === true
						? "todas"
						: viewCount > 0
							? `${viewCount} marcadas`
							: "nenhuma",
				tone: form.copyViews === true || viewCount > 0 ? "ok" : "muted",
				reason,
			};
		}
		case "indexes":
			return {
				value:
					form.copyIndexes === true
						? "todos"
						: form.copyIndexes === false
							? "nenhum"
							: `${form.copyIndexes.reduce((n, e) => n + e.indexes.length, 0)} marcados`,
				tone:
					form.copyIndexes === true || Array.isArray(form.copyIndexes)
						? "ok"
						: "muted",
				reason,
			};
		case "backend":
			return { value: backend };
		case "boot": {
			const warn =
				boot && needsSudo(backend) ? " ⚠ vai precisar de sudo (1 comando)" : "";
			return {
				value: (boot ? "sim" : "não") + warn,
				tone: boot ? "ok" : "muted",
			};
		}
	}
}

function EditorFor(props: {
	id: FieldId;
	name: string;
	setName: (v: string) => void;
	mode: TuiMode;
	setMode: (m: TuiMode) => void;
	configPath: string;
	configs: { file: string; kind: string }[];
	onSelectConfig: (value: string) => void;
	form: FormState;
	updateForm: (patch: Partial<FormState>) => void;
	source: ReturnType<typeof useInspector>;
	destination: ReturnType<typeof useInspector>;
	sourceConnected: boolean;
	destConnected: boolean;
	textBuf: string;
	setTextBuf: (v: string) => void;
	backend: Backend;
	setBackend: (b: Backend) => void;
	availability: BackendAvailability[] | null;
	onCloseEditor: () => void;
}) {
	const { id } = props;

	switch (id) {
		case "name":
			return (
				<TextInput
					value={props.name}
					onChange={props.setName}
					onSubmit={props.onCloseEditor}
					focus
					placeholder="nome-do-serviço"
				/>
			);

		case "mode":
			return (
				<Select
					items={MODES.map((m) => ({
						value: m.value,
						label: m.label,
						hint: m.hint,
					}))}
					onSelect={props.setMode}
					focus
					visible={3}
					initialIndex={MODES.findIndex((m) => m.value === props.mode)}
				/>
			);

		case "config":
			return (
				<Select
					items={[
						{
							value: HERE,
							label: "— definir aqui —",
							hint: "grava um yml novo",
						},
						...props.configs.map((c) => ({
							value: c.file,
							label: c.file,
							hint: c.kind,
						})),
					]}
					onSelect={props.onSelectConfig}
					focus
					visible={6}
					initialIndex={Math.max(
						0,
						props.configs.findIndex((c) => c.file === props.configPath) + 1,
					)}
				/>
			);

		case "sourceUri":
			return (
				<TextInput
					value={props.form.source.uri}
					onChange={(uri) =>
						props.updateForm({ source: { ...props.form.source, uri } })
					}
					onSubmit={async (uri) => {
						props.onCloseEditor();
						if (uri.trim()) await props.source.connect(uri.trim());
					}}
					focus
					placeholder="mongodb+srv://user:senha@cluster.mongodb.net"
				/>
			);

		case "destUri":
			return (
				<TextInput
					value={props.form.destination.uri}
					onChange={(uri) =>
						props.updateForm({
							destination: { ...props.form.destination, uri },
						})
					}
					onSubmit={async (uri) => {
						props.onCloseEditor();
						if (uri.trim()) await props.destination.connect(uri.trim());
					}}
					focus
					placeholder="mongodb+srv://user:senha@cluster.mongodb.net"
				/>
			);

		case "sourceDb":
			return (
				<DbEditor
					db={props.form.source.db}
					connected={props.sourceConnected}
					databases={props.source.state.databases}
					onPreview={(n) => void props.source.loadDb(n)}
					onChange={(db) =>
						props.updateForm({ source: { ...props.form.source, db } })
					}
					onConfirm={async (db) => {
						props.updateForm({ source: { ...props.form.source, db } });
						if (props.sourceConnected) await props.source.loadDb(db);
						props.onCloseEditor();
					}}
				/>
			);

		case "destDb":
			return (
				<DbEditor
					db={props.form.destination.db}
					connected={props.destConnected}
					databases={props.destination.state.databases}
					onPreview={(n) => void props.destination.loadDb(n)}
					onChange={(db) =>
						props.updateForm({ destination: { ...props.form.destination, db } })
					}
					onConfirm={async (db) => {
						props.updateForm({
							destination: { ...props.form.destination, db },
						});
						props.onCloseEditor();
					}}
				/>
			);

		case "backend":
			return (
				<Select
					items={(props.availability ?? []).map((a) => ({
						value: a.backend,
						label: a.backend,
						disabled: !a.available,
						hint: [a.reason, a.fix ? `→ ${a.fix}` : undefined]
							.filter(Boolean)
							.join("  "),
					}))}
					onSelect={props.setBackend}
					focus
					visible={4}
					emptyMessage="checando backends…"
					initialIndex={Math.max(
						0,
						(props.availability ?? []).findIndex(
							(a) => a.backend === props.backend,
						),
					)}
				/>
			);

		default:
			return null;
	}
}

/** Editor comum a origem.db/destino.db: Select quando conectado, texto livre senão. */
function DbEditor({
	db,
	connected,
	databases,
	onPreview,
	onChange,
	onConfirm,
}: {
	db: string;
	connected: boolean;
	databases: { name: string; sizeOnDisk: number }[];
	onPreview: (name: string) => void;
	onChange: (db: string) => void;
	onConfirm: (db: string) => Promise<void>;
}) {
	if (connected && databases.length > 0)
		return (
			<Select
				items={[
					...databases.map((info) => ({
						value: info.name,
						label: info.name,
						hint: info.name === db ? "atual" : undefined,
					})),
					{ value: TYPE_NEW, label: "＋ digitar outro nome", hint: undefined },
				]}
				onSelect={(value) => {
					if (value === TYPE_NEW) return;
					void onConfirm(value);
				}}
				onHighlight={(value) => {
					if (value !== TYPE_NEW) onPreview(value);
				}}
				focus
				visible={6}
				initialIndex={Math.max(
					0,
					databases.findIndex((i) => i.name === db),
				)}
			/>
		);

	return (
		<TextInput
			value={db}
			onChange={onChange}
			onSubmit={(v) => void onConfirm(v)}
			focus
			placeholder="nome-do-banco"
		/>
	);
}
