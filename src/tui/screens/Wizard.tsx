import { Box, Text } from "ink";
import { useState } from "react";
import { emptyForm, type FormState } from "../../core/config/formState";
import type { CollectionEntryRaw } from "../../core/config/loadConfig";
import { maskUri } from "../../core/inspect/maskUri";
import type { TuiMode } from "../../core/inspect/summary";
import { Frame, type Hint } from "../components/Frame";
import { Select } from "../components/Select";
import { useInspector } from "../hooks/useInspector";
import { theme } from "../theme";
import { AdvancedStep } from "./wizard/AdvancedStep";
import { CollectionsStep } from "./wizard/CollectionsStep";
import { ConnectionStep } from "./wizard/ConnectionStep";
import { ReviewStep } from "./wizard/ReviewStep";

/**
 * O wizard em si: mantém o `FormState` e decide qual passo mostrar.
 *
 * Cada passo é um componente burro que recebe um pedaço do form e devolve o
 * pedaço alterado — a máquina de estados mora aqui e só aqui. Foi o que
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

const MODES: { value: TuiMode; label: string; hint: string }[] = [
	{
		value: "sync",
		label: "sync",
		hint: "réplica contínua via change stream (roda 24/7)",
	},
	{
		value: "migrate",
		label: "migrate",
		hint: "cópia pontual via mongodump/mongorestore",
	},
	{
		value: "ttl",
		label: "ttl",
		hint: "cria índices TTL em massa (não copia dados)",
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
	const [form, setForm] = useState<FormState>(initialForm ?? emptyForm("sync"));
	// Um yml aberto para edição já tem tudo preenchido: começar na revisão
	// evita obrigar a percorrer o wizard inteiro para trocar uma linha.
	const [step, setStep] = useState<Step>(initialForm ? "review" : "mode");
	const source = useInspector();
	const destination = useInspector();

	const views = source.state.overview?.views ?? [];

	function back() {
		const order: Step[] = stepOrder(form.mode);
		const i = order.indexOf(step);
		if (i <= 0) onExit();
		else setStep(order[i - 1] as Step);
	}

	function next() {
		const order = stepOrder(form.mode);
		const i = order.indexOf(step);
		setStep((order[i + 1] ?? "review") as Step);
	}

	return (
		<Frame
			title={titleFor(step, form.mode)}
			subtitle={subtitleFor(form, step)}
			hints={hintsFor(step, form.mode)}
		>
			{step === "mode" ? (
				<Box flexDirection="column">
					<Text color={theme.muted}>O que este arquivo vai fazer?</Text>
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
					mode={form.mode}
					dbName={form.source.db}
					selected={form.collections}
					onChange={(collections) => setForm((f) => ({ ...f, collections }))}
					inspector={source}
					copyIndexes={form.copyIndexes}
					copyViews={form.copyViews}
					onDone={next}
					onBack={back}
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
					onSaved={(path, action) =>
						action === "run" ? onRun(path) : onExit()
					}
					onBack={back}
				/>
			) : null}
		</Frame>
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

function titleFor(step: Step, mode: TuiMode): string {
	const n = stepOrder(mode).indexOf(step) + 1;
	const total = stepOrder(mode).length;
	const names: Record<Step, string> = {
		mode: "modo",
		source: "origem",
		destination: "destino",
		collections: "collections",
		advanced: "avançado",
		review: "revisar e salvar",
	};
	return `nova config · ${n}/${total} ${names[step]}`;
}

function subtitleFor(form: FormState, step: Step): string | undefined {
	if (step === "mode") return undefined;
	const parts: string[] = [form.mode];
	if (form.source.db) parts.push(`de ${form.source.db}`);
	if (form.mode !== "ttl" && form.destination.db)
		parts.push(`para ${form.destination.db}`);
	if (step === "review" && form.source.uri)
		parts.push(maskUri(form.source.uri).slice(0, 28));
	return parts.join(" ");
}

function hintsFor(step: Step, mode: TuiMode): Hint[] {
	const back: Hint = { keys: "esc", label: mode ? "voltar" : "sair" };
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
				back,
			];
		case "collections":
			return [
				{ keys: "espaço", label: "marcar" },
				{ keys: "/", label: "buscar" },
				{ keys: "a/n", label: "todas/nenhuma" },
				{ keys: "c", label: "contar exato" },
				{ keys: "e", label: "estimativas" },
				{ keys: "enter", label: "seguir" },
				back,
			];
		case "advanced":
			return [
				{ keys: "espaço", label: "ligar/desligar" },
				{ keys: "enter", label: "editar/seguir" },
				{ keys: "v", label: "escolher views" },
				back,
			];
		case "review":
			return [
				{ keys: "enter", label: "salvar" },
				{ keys: "r", label: "salvar e rodar" },
				{ keys: "e", label: "nome do arquivo" },
				back,
			];
	}
}
