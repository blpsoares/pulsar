import { relative, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { detectConfigs } from "../../core/compose/detectConfigs";
import { buildConfig } from "../../core/config/buildConfig";
import {
	emptyForm,
	type FormState,
	validateForm,
} from "../../core/config/formState";
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
	type StepResult,
} from "../../core/service/manager";
import { detectSudo, type SudoMode } from "../../core/service/privileged";
import {
	type Backend,
	type ServiceSpec,
	type ServiceStep,
	serviceName,
} from "../../core/service/types";
import {
	CREATED_BY_TUI,
	type ServiceRecord,
	writeRecord,
} from "../../core/state/registry";
import { parseDuration } from "../../core/ttl/parseDuration";
import { CollectionsStep } from "../components/form/CollectionsStep";
import { DEFAULT_ESTIMATE_OPTIONS } from "../components/form/EstimatesPanel";
import { IndexesStep } from "../components/form/IndexesStep";
import { ViewsStep } from "../components/form/ViewsStep";
import { Overlay } from "../components/Overlay";
import { Select } from "../components/Select";
import { Stat } from "../components/Shell";
import { SudoConfirm } from "../components/SudoConfirm";
import { TextInput } from "../components/TextInput";
import { useInspector } from "../hooks/useInspector";
import { listWindow, overlayBox } from "../layout";
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
	type ManualStepResult,
	manualStepResults,
	needsSudo,
	parseCommaList,
	parseIndexesList,
	resolveFinalBoot,
	visibleFields,
} from "./serviceFormFields";

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
	onHelp,
	enabled = true,
}: {
	dir: string;
	initial?: ServiceRecord;
	columns: number;
	rows: number;
	onCancel: () => void;
	onSubmit: (draft: ServiceDraft, andStart: boolean) => void;
	/**
	 * `?` é tratado AQUI, e não no `App`, por um motivo prático: uma URI do
	 * Atlas tem `?retryWrites=true`. Um handler global de `?` abriria a ajuda no
	 * meio da digitação da origem. Este handler é o que já ignora tecla quando
	 * um editor de campo está aberto.
	 */
	onHelp?: () => void;
	/** false quando a ajuda está por cima — só a camada de cima escuta */
	enabled?: boolean;
}) {
	// O registro guarda o nome COM prefixo (`pulsar-x`); o campo edita o SUFIXO,
	// que é o que `serviceName()` reprefixa na gravação — sem tirar aqui, salvar
	// de novo criaria `pulsar-pulsar-x`.
	const [name, setName] = useState(
		(initial?.name ?? "").replace(/^pulsar-/, ""),
	);
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
	// Uma instalação por vez — `ctrl+s`/`ctrl+o` disparado duas vezes rápido
	// (dois eventos de tecla antes do 1º `await` resolver) não pode abrir duas
	// instalações concorrentes.
	const submitting = useRef(false);
	const [pending, setPending] = useState<{
		/** passo ESSENCIAL que falhou — instalação não terminou `ok` (Fix 1, Rodada 2) */
		failed: StepResult | null;
		skipped: ServiceStep[];
		manual: ManualStepResult[];
		notes: string[];
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

	/**
	 * `field` e `deriveFromId` são mutuamente exclusivos no schema do ttl (ver
	 * `ttlCollectionEntrySchema`/`ttlDefaultsSchema` em `types/parseYml.ts` e o
	 * `.refine` de `resolveTtlEntry.ts`) — ligar aqui DESLIGA o campo de data,
	 * mesmo padrão já usado em `wizard/AdvancedStep.tsx`.
	 */
	function toggleDeriveFromId() {
		updateForm({
			ttlDefaults: {
				...form.ttlDefaults,
				deriveFromId: !form.ttlDefaults.deriveFromId,
				field: form.ttlDefaults.deriveFromId
					? form.ttlDefaults.field
					: undefined,
			},
		});
	}

	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (askStep || installing || pending) return;
			if (editing) return; // o editor do campo é quem escuta

			if (input === "?") {
				onHelp?.();
				return;
			}
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
				else if (currentField === "ttlDeriveFromId") toggleDeriveFromId();
				return;
			}
			if (key.return) {
				if (!currentField) return;
				if (currentField === "boot") toggleBoot();
				else if (currentField === "ttlDeriveFromId") toggleDeriveFromId();
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
		{ isActive: enabled },
	);

	// `esc` fecha o editor dos campos COMPACTOS (TextInput, Select não tratam
	// escape sozinhos). Os campos LARGOS (collections/views/índices) só ficam
	// de fora QUANDO conectados: aí é o picker de verdade (CollectionsStep etc)
	// quem está na tela, com um modo de busca próprio em que `esc` significa
	// "sair da busca", não "fechar o campo" — um handler genérico fecharia o
	// editor por baixo do usuário no meio de uma busca.
	//
	// SEM conexão, porém, o editor desses mesmos campos é só o `TextInput` de
	// texto livre do `WideEditor` (Requisito 2: "digitar os nomes à mão, sem
	// Mongo" tem que funcionar até o fim) — e o rodapé dali literalmente
	// anuncia "esc volta". Sem esta ressalva, `esc` não fazia NADA nesse
	// caminho: tecla anunciada e sem efeito (Fix 2, Rodada 2).
	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (!editing) return;
			if (isWideField(editing) && sourceConnected) return;
			if (key.escape) closeEditor();
		},
		{ isActive: enabled && Boolean(editing) },
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
		{ isActive: enabled && Boolean(askStep) },
	);

	// Relatório final (pendências/falha) — enter/esc fecham e entregam ao
	// chamador. Faltava o guard de mouse aqui (único dos quatro `useInput` sem
	// ele — Fix 4, Rodada 2): um chunk de mouse partido pode chegar como `\x1B`
	// solto, que o ink lê como escape, e fechar o relatório antes da hora — e é
	// justamente aqui que mora a saída do `pm2 startup` que o Fix 6 preserva.
	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (!pending) return;
			if (key.return || key.escape) {
				const { draft, andStart } = pending;
				setPending(null);
				onSubmit(draft, andStart);
			}
		},
		{ isActive: enabled && Boolean(pending) },
	);

	async function ask(step: ServiceStep): Promise<boolean> {
		return new Promise((finish) => {
			askResolver.current = finish;
			setAskStep(step);
		});
	}

	async function submit(andStart: boolean) {
		// Fix 7 (Rodada 2): `ctrl+s` duas vezes rápido dispara `submit` duas
		// vezes antes do 1º `await` resolver — sem este guard, isso abria duas
		// instalações concorrentes do mesmo serviço. A checagem/gravação é
		// SÍNCRONA (antes de qualquer `await`), então a 2ª chamada vê o ref já
		// marcado e sai na hora.
		if (submitting.current) return;
		submitting.current = true;
		try {
			await doSubmit(andStart);
		} finally {
			submitting.current = false;
		}
	}

	async function doSubmit(andStart: boolean) {
		const config = buildConfig(form, preserved);
		// `validateConfig` (Zod) sozinho NÃO barra um `ttl` sem `field`/
		// `deriveFromId`/`expire` — o schema declara os três como opcionais
		// (a exigência de "pelo menos um" é regra de negócio, resolvida em
		// runtime por `resolveTtlEntry`, não em formato). `validateForm` cobre
		// exatamente essa regra (e a mesma mutual-exclusão), com mensagem em
		// português — Fix 1 da Rodada 1.
		const errors = [
			...validateForm(form).map((e) => e.message),
			...validateConfig(mode, config),
		];
		if (mode === "ttl" && form.ttlDefaults.expire) {
			// A unidade ('m' sozinho proibido, por ambíguo minuto/mês) só é
			// validada pelo formato de `parseDuration` — reaproveitado aqui em vez
			// de duplicar o regex.
			try {
				parseDuration(form.ttlDefaults.expire);
			} catch (err) {
				errors.push(err instanceof Error ? err.message : String(err));
			}
		}
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
			// Fix 3 (Rodada 2): o registro sempre descreve ESTE `dir` — é onde
			// `spec.workingDir` aponta (logo abaixo) e onde `ecosystemPath`/
			// `composePath` gravam os arquivos do serviço. `initial.workingDir`
			// nunca foi usado aqui de propósito.
			writeRecord(recordFor(draft, dir, initial));
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

		const manual = manualStepResults(result.results, plan.manualSteps);
		// `boot: false` gravado quando a instalação NÃO terminou `ok` (passo
		// essencial falhou — os passos de boot nem rodaram), quando algum passo
		// com sudo foi recusado, ou quando existiu QUALQUER passo manual (mesmo
		// saindo com código 0, pode ter só IMPRESSO instrução — ver
		// `resolveFinalBoot`). O boot REALMENTE não ficou habilitado nesses
		// casos, e o registro tem que descrever a realidade, não uma promessa.
		const finalBoot = resolveFinalBoot(
			boot,
			result.ok,
			result.skippedPrivileged,
			manual,
		);
		const finalDraft: ServiceDraft = { ...draft, boot: finalBoot };
		writeRecord(recordFor(finalDraft, dir, initial));

		// Fix 1 (Rodada 2): `result.ok === false` (passo ESSENCIAL falhou, ex.:
		// `systemctl --user start` ou `docker compose up --build` estourando o
		// teto) não pode virar "start bem-sucedido" só porque nada ficou
		// pulado/manual — muitas vezes é o OPOSTO: a falha interrompe o laço
		// ANTES de chegar nos passos de boot, então `skippedPrivileged`/`manual`
		// saem vazios mesmo a instalação tendo falhado. O passo que falhou é
		// sempre o ÚLTIMO de `result.results` quando `!result.ok` — o loop em
		// `manager.ts` grava o resultado e quebra na sequência, nunca depois.
		const failed = result.ok ? null : (result.results.at(-1) ?? null);

		if (failed || result.skippedPrivileged.length > 0 || manual.length > 0) {
			setPending({
				failed,
				skipped: result.skippedPrivileged,
				manual,
				notes: plan.notes,
				draft: finalDraft,
				andStart: true,
			});
			return;
		}

		onSubmit(finalDraft, true);
	}

	const box = overlayBox(columns, rows);
	const innerWidth = Math.max(20, box.width - 4);

	// Fix 2 (Rodada 1): o `Box` do ink 7 não recorta o próprio conteúdo — com 12
	// a 15 campos num overlay de terminal baixo, desenhar linha a mais não CORTA
	// a saída, CORROMPE o frame (mesmo motivo documentado em `layout.ts` e já
	// tratado assim em `ServicesPanel`). `listWindow` é o helper existente da
	// Task 11; duas passadas porque reservar 1 linha por indicador (▲/▼) pode,
	// ele mesmo, estourar a altura calculada na 1ª passada.
	const fieldAreaHeight = Math.max(3, box.height - 4);
	const provisionalWin = listWindow(fields.length, fieldAreaHeight, cur);
	const reserved =
		(provisionalWin.start > 0 ? 1 : 0) +
		(provisionalWin.end < fields.length ? 1 : 0);
	const fieldWin =
		reserved > 0
			? listWindow(fields.length, Math.max(1, fieldAreaHeight - reserved), cur)
			: provisionalWin;
	const fieldRows = fields
		.slice(fieldWin.start, fieldWin.end)
		.map((id, i) => ({ id, index: fieldWin.start + i }));

	if (askStep)
		return <SudoConfirm step={askStep} columns={columns} rows={rows} />;

	if (installing)
		return (
			<Overlay title="instalando" columns={columns} rows={rows}>
				<Text color={theme.muted}>gravando arquivos e rodando os passos…</Text>
			</Overlay>
		);

	if (pending)
		return (
			<Overlay
				title={pending.failed ? "instalação falhou" : "ficou pendente"}
				columns={columns}
				rows={rows}
			>
				{pending.failed ? (
					<Box flexDirection="column" marginBottom={1}>
						<Text color={theme.error} wrap="wrap">
							✖ passo essencial falhou — o serviço NÃO foi instalado
						</Text>
						<Text wrap="wrap">
							<Text color={theme.label}>
								{pending.failed.step.cmd} {pending.failed.step.args.join(" ")}
							</Text>
							<Text color={theme.muted}> — {pending.failed.step.why}</Text>
						</Text>
						{pending.failed.output ? (
							<Text color={theme.muted} wrap="wrap">
								{"  "}
								{pending.failed.output.split("\n").slice(-6).join("\n  ")}
							</Text>
						) : null}
					</Box>
				) : null}
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
				{pending.notes.length > 0 ? (
					<Box flexDirection="column" marginTop={1}>
						{pending.notes.map((n) => (
							<Text key={n} color={theme.muted} wrap="wrap">
								· {n}
							</Text>
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
					{fieldWin.start > 0 ? (
						<Text color={theme.muted}>▲ +{fieldWin.start} acima</Text>
					) : null}
					{fieldRows.map(({ id, index }) => (
						<FieldRow
							key={id}
							id={id}
							clickable={enabled}
							active={index === cur}
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
									// Fix 8 (Rodada 2): sem isto, `preserved` (os filtros do
									// yml anterior, indexados por nome de collection) sobrevivia
									// à troca e `buildConfig` os mesclava de volta num arquivo
									// NOVO que nunca teve esses filtros.
									setPreserved(undefined);
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
								setCursor(index);
								if (id === "boot") toggleBoot();
								else if (id === "ttlDeriveFromId") toggleDeriveFromId();
								else openEditor(id);
							}}
							onCloseEditor={closeEditor}
						/>
					))}
					{fieldWin.end < fields.length ? (
						<Text color={theme.muted}>
							▼ +{fields.length - fieldWin.end} abaixo
						</Text>
					) : null}
				</Box>
			)}
		</Overlay>
	);
}

/**
 * `workingDir` é sempre `dir` (o diretório desta sessão da TUI) — nunca
 * `initial.workingDir` (Fix 3, Rodada 2). Todas as outras telas registram
 * `dir`, e é ele que `spec.workingDir` usa alguns passos acima: divergir
 * aqui deixaria o registro descrevendo uma pasta diferente daquela onde a
 * unit/ecosystem/compose foram de fato gravados (`ecosystemPath`/
 * `composePath` são `join(spec.workingDir, …)`).
 */
function recordFor(
	draft: ServiceDraft,
	dir: string,
	initial?: ServiceRecord,
): ServiceRecord {
	return {
		// O registro guarda o nome COMO O SUPERVISOR o conhece (`pulsar-<slug>`),
		// não o que foi digitado. É o que `reconcile` cruza com o
		// `discoverServices()` e o que `specFromRecord` desfaz para voltar a
		// `ServiceSpec`. Gravando o nome cru, o mesmo serviço aparecia DUAS vezes
		// na lista — "adotado" (o que o systemd vê) e "não instalado" (o
		// registro) — e nenhuma das duas linhas funcionava.
		name: serviceName({ name: draft.name }),
		mode: draft.mode,
		config: draft.configPath,
		workingDir: dir,
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
	/** false quando a ajuda está por cima: o clique também obedece à pilha */
	clickable: boolean;
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

	const ref = useClickable({
		onClick: props.onOpen,
		enabled: props.clickable,
	});

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
		case "ttlField":
			return form.ttlDefaults.deriveFromId
				? { value: "— (usando derivar do _id)", tone: "muted" }
				: {
						value: form.ttlDefaults.field || "—",
						tone: form.ttlDefaults.field ? undefined : "muted",
					};
		case "ttlDeriveFromId":
			return {
				value: form.ttlDefaults.deriveFromId ? "sim" : "não",
				tone: form.ttlDefaults.deriveFromId ? "ok" : "muted",
			};
		case "ttlExpire":
			return {
				value: form.ttlDefaults.expire || "—",
				tone: form.ttlDefaults.expire ? undefined : "muted",
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

		case "ttlField":
			// `field` e `deriveFromId` são mutuamente exclusivos (schema em
			// `types/parseYml.ts`): digitar um nome aqui DESLIGA `deriveFromId`,
			// mesmo padrão de `wizard/AdvancedStep.tsx`.
			return (
				<TextInput
					value={props.form.ttlDefaults.field ?? ""}
					onChange={(field) =>
						props.updateForm({
							ttlDefaults: {
								...props.form.ttlDefaults,
								field: field || undefined,
								deriveFromId: field
									? false
									: props.form.ttlDefaults.deriveFromId,
							},
						})
					}
					onSubmit={props.onCloseEditor}
					focus
					placeholder="createdAt (campo Date existente que ancora o TTL)"
				/>
			);

		case "ttlExpire":
			return (
				<TextInput
					value={props.form.ttlDefaults.expire ?? ""}
					onChange={(expire) =>
						props.updateForm({
							ttlDefaults: {
								...props.form.ttlDefaults,
								expire: expire || undefined,
							},
						})
					}
					onSubmit={props.onCloseEditor}
					focus
					// 'm' sozinho é proibido (ambíguo minuto/mês) — use min ou mo.
					placeholder="30d, 6mo, 1h… ('m' sozinho é proibido: use min ou mo)"
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
