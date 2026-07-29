import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { FormState } from "../../../core/config/formState";
import type { DbEntry } from "../../../core/inspect/inspectDb";
import { TextInput } from "../../components/TextInput";
import { glyph, theme } from "../../theme";

/**
 * Opções avançadas, por modo. Todas já vêm com o default do pulsar — quem não
 * quiser mexer aperta enter e segue.
 *
 * Os campos são descritos como DADO (a lista `rows`) em vez de JSX repetido:
 * cada opção nova é uma linha aqui, e o comportamento de navegação/edição vale
 * para todas sem duplicação.
 */

type Row =
	| {
			kind: "toggle";
			label: string;
			hint: string;
			get: (f: FormState) => boolean;
			set: (f: FormState, value: boolean) => FormState;
	  }
	| {
			kind: "text";
			label: string;
			hint: string;
			placeholder: string;
			get: (f: FormState) => string;
			set: (f: FormState, value: string) => FormState;
	  };

function rowsFor(form: FormState): Row[] {
	if (form.mode === "sync") return syncRows();
	if (form.mode === "migrate") return migrateRows();
	return ttlRows();
}

function syncRows(): Row[] {
	return [
		{
			kind: "toggle",
			label: "copyIndexes",
			hint: "recria os índices secundários da origem no destino",
			get: (f) => f.copyIndexes,
			set: (f, v) => ({ ...f, copyIndexes: v }),
		},
		{
			kind: "toggle",
			label: "copyViews",
			hint: "recria as views da origem (v escolhe quais)",
			get: (f) => f.copyViews !== false,
			// Ligar aqui significa "todas"; a seleção fina é pela tecla `v`.
			set: (f, v) => ({ ...f, copyViews: v }),
		},
		{
			kind: "toggle",
			label: "logging.verbose",
			hint: "loga cada evento do change stream",
			get: (f) => f.logging.verbose,
			set: (f, v) => ({ ...f, logging: { ...f.logging, verbose: v } }),
		},
		{
			kind: "toggle",
			label: "logging.progress",
			hint: "barra de progresso no dump inicial (só com TTY)",
			get: (f) => f.logging.progress,
			set: (f, v) => ({ ...f, logging: { ...f.logging, progress: v } }),
		},
		{
			kind: "text",
			label: "performance.parallel",
			hint: "collections em dump simultâneo — padrão 3",
			placeholder: "3",
			get: (f) => numToStr(f.performance.parallel),
			set: (f, v) => ({
				...f,
				performance: { ...f.performance, parallel: strToNum(v) },
			}),
		},
		{
			kind: "text",
			label: "performance.batchSize",
			hint: "docs por lote no dump — padrão 500",
			placeholder: "500",
			get: (f) => numToStr(f.performance.batchSize),
			set: (f, v) => ({
				...f,
				performance: { ...f.performance, batchSize: strToNum(v) },
			}),
		},
		{
			kind: "text",
			label: "performance.flushIntervalMs",
			hint: "intervalo de flush do buffer do watch — padrão 1000",
			placeholder: "1000",
			get: (f) => numToStr(f.performance.flushIntervalMs),
			set: (f, v) => ({
				...f,
				performance: { ...f.performance, flushIntervalMs: strToNum(v) },
			}),
		},
	];
}

function migrateRows(): Row[] {
	return [
		{
			kind: "text",
			label: "queryString",
			hint: 'filtro do mongodump em JSON, ex.: {"status":"active"}',
			placeholder: "(sem filtro)",
			get: (f) => f.queryString ?? "",
			set: (f, v) => ({ ...f, queryString: v }),
		},
	];
}

function ttlRows(): Row[] {
	return [
		{
			kind: "text",
			label: "field",
			hint: "campo Date existente que ancora o TTL",
			placeholder: "createdAt",
			get: (f) => f.ttlDefaults.field ?? "",
			set: (f, v) => ({
				...f,
				ttlDefaults: {
					...f.ttlDefaults,
					field: v || undefined,
					// field e deriveFromId são mutuamente exclusivos no pulsar;
					// preencher um desliga o outro em vez de gerar yml inválido.
					deriveFromId: v ? false : f.ttlDefaults.deriveFromId,
				},
			}),
		},
		{
			kind: "toggle",
			label: "deriveFromId",
			hint: "materializa _created a partir do _id (só ObjectId)",
			get: (f) => f.ttlDefaults.deriveFromId === true,
			set: (f, v) => ({
				...f,
				ttlDefaults: {
					...f.ttlDefaults,
					deriveFromId: v,
					field: v ? undefined : f.ttlDefaults.field,
				},
			}),
		},
		{
			kind: "text",
			label: "expire",
			hint: "30d, 6mo, 1h… ('m' sozinho é proibido: use min ou mo)",
			placeholder: "30d",
			get: (f) => f.ttlDefaults.expire ?? "",
			set: (f, v) => ({
				...f,
				ttlDefaults: { ...f.ttlDefaults, expire: v || undefined },
			}),
		},
		{
			kind: "text",
			label: "performance.parallel",
			hint: "collections com TTL em paralelo — padrão 4",
			placeholder: "4",
			get: (f) => numToStr(f.performance.parallel),
			set: (f, v) => ({
				...f,
				performance: { ...f.performance, parallel: strToNum(v) },
			}),
		},
	];
}

export function AdvancedStep({
	form,
	onChange,
	views,
	onDone,
	onBack,
	focused,
}: {
	form: FormState;
	onChange: (next: FormState) => void;
	views: DbEntry[];
	onDone: () => void;
	onBack: () => void;
	/** false quando o foco está no trilho de passos */
	focused: boolean;
}) {
	const rows = rowsFor(form);
	const [cursor, setCursor] = useState(0);
	const [editing, setEditing] = useState(false);
	const [viewPicker, setViewPicker] = useState(false);

	const row = rows[Math.min(cursor, rows.length - 1)];

	useInput(
		(input, key) => {
			if (editing || viewPicker) return;

			if (key.escape) {
				onBack();
				return;
			}
			if (key.upArrow) {
				setCursor((c) => (c === 0 ? rows.length - 1 : c - 1));
				return;
			}
			if (key.downArrow) {
				setCursor((c) => (c === rows.length - 1 ? 0 : c + 1));
				return;
			}
			if (input === " " && row?.kind === "toggle") {
				onChange(row.set(form, !row.get(form)));
				return;
			}
			if (
				input === "v" &&
				form.mode === "sync" &&
				views.length > 0 &&
				form.copyViews !== false
			) {
				setViewPicker(true);
				return;
			}
			if (key.return) {
				if (row?.kind === "text") setEditing(true);
				else onDone();
			}
		},
		{ isActive: focused },
	);

	if (viewPicker)
		return (
			<ViewPicker
				views={views}
				value={form.copyViews}
				onChange={(copyViews) => onChange({ ...form, copyViews })}
				onClose={() => setViewPicker(false)}
			/>
		);

	return (
		<Box flexDirection="column">
			<Text color={theme.muted}>
				Defaults do pulsar já aplicados — enter numa linha de texto edita,
				espaço liga/desliga.
			</Text>

			<Box flexDirection="column" marginTop={1}>
				{rows.map((r, i) => {
					const active = i === cursor;
					return (
						<Box key={r.label}>
							<Text color={active ? theme.selection : undefined}>
								{active ? `${glyph.cursor} ` : "  "}
							</Text>
							{r.kind === "toggle" ? (
								<Text color={r.get(form) ? theme.ok : theme.muted}>
									{r.get(form) ? glyph.boxChecked : glyph.boxUnchecked}{" "}
								</Text>
							) : null}
							<Text bold={active}>{r.label}</Text>
							<Text color={theme.muted}> = </Text>
							{r.kind === "text" ? (
								<TextInput
									value={r.get(form)}
									onChange={(value) => onChange(r.set(form, value))}
									onSubmit={() => setEditing(false)}
									focus={editing && active && focused}
									placeholder={r.placeholder}
								/>
							) : (
								<Text color={r.get(form) ? theme.ok : theme.muted}>
									{String(r.get(form))}
								</Text>
							)}
							{active ? (
								<Text color={theme.muted} wrap="truncate-end">
									{"   "}
									{r.hint}
								</Text>
							) : null}
						</Box>
					);
				})}
			</Box>

			{form.mode === "sync" && Array.isArray(form.copyViews) ? (
				<Box marginTop={1}>
					<Text color={theme.muted}>
						views escolhidas:{" "}
						{form.copyViews.length ? form.copyViews.join(", ") : "nenhuma"}
					</Text>
				</Box>
			) : null}
		</Box>
	);
}

function ViewPicker({
	views,
	value,
	onChange,
	onClose,
}: {
	views: DbEntry[];
	value: boolean | string[];
	onChange: (next: boolean | string[]) => void;
	onClose: () => void;
}) {
	const selected = new Set(
		Array.isArray(value) ? value : views.map((v) => v.name),
	);
	const [cursor, setCursor] = useState(0);

	useInput((input, key) => {
		if (key.escape || key.return) {
			onClose();
			return;
		}
		if (key.upArrow) {
			setCursor((c) => (c === 0 ? views.length - 1 : c - 1));
			return;
		}
		if (key.downArrow) {
			setCursor((c) => (c === views.length - 1 ? 0 : c + 1));
			return;
		}
		if (input === " ") {
			const name = views[cursor]?.name;
			if (!name) return;
			const next = new Set(selected);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			// Marcar todas volta a ser `true` no yml: mais legível e continua
			// pegando views criadas na origem depois deste momento.
			onChange(next.size === views.length ? true : Array.from(next));
		}
	});

	return (
		<Box flexDirection="column">
			<Text color={theme.accent} bold>
				quais views recriar no destino
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{views.map((v, i) => (
					<Box key={v.name}>
						<Text color={i === cursor ? theme.selection : undefined}>
							{i === cursor ? `${glyph.cursor} ` : "  "}
							<Text color={selected.has(v.name) ? theme.ok : theme.muted}>
								{selected.has(v.name) ? glyph.checked : glyph.unchecked}
							</Text>{" "}
							{v.name}
						</Text>
						<Text color={theme.muted}> sobre {v.viewOn ?? "?"}</Text>
					</Box>
				))}
			</Box>
			<Box marginTop={1}>
				<Text color={theme.muted}>espaço marca · enter/esc volta</Text>
			</Box>
		</Box>
	);
}

function numToStr(n?: number): string {
	return n === undefined ? "" : String(n);
}

function strToNum(v: string): number | undefined {
	const n = Number(v.trim());
	return v.trim() && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
