import { Box, Text } from "ink";
import { useEffect } from "react";
import type { CollIndexes } from "../../../core/inspect/indexSummary";
import type { CopyIndexesOption } from "../../../types/parseYml";
import { EntryPicker, type PickerItem } from "../../components/EntryPicker";
import type { useInspector } from "../../hooks/useInspector";
import { theme } from "../../theme";

/**
 * Quais índices recriar no destino.
 *
 * O dump doc-a-doc do sync leva os DADOS, nunca os índices secundários — quem
 * quiser os índices na réplica precisa pedir. E pedir "todos" nem sempre serve:
 * construir índice em collection de centenas de milhões de docs custa horas e
 * disco, e a réplica costuma existir para 2 ou 3 consultas conhecidas. Por isso
 * a escolha é por índice, não por collection.
 *
 * A lista só traz as collections SELECIONADAS: índice de collection que não vai
 * ser sincronizada não tem onde ser criado.
 */

/**
 * `collection` e `indexName` viram uma chave só para a lista. O separador é NUL,
 * que não pode existir em nenhum dos dois — um ponto seria ambíguo, já que tanto
 * nome de collection quanto de índice aceitam ponto.
 */
const SEP = "\u0000";

export function IndexesStep({
	dbName,
	collections,
	value,
	onChange,
	inspector,
	onDone,
	onBack,
	focused,
	visibleRows,
}: {
	dbName: string;
	collections: string[];
	value: CopyIndexesOption;
	onChange: (next: CopyIndexesOption) => void;
	inspector: ReturnType<typeof useInspector>;
	onDone: () => void;
	onBack: () => void;
	focused: boolean;
	visibleRows: number;
}) {
	const { state, loadStats } = inspector;
	const key = collections.join(",");

	// Os índices são lidos aqui, e não no passo de collections: lá a leitura é
	// opt-in (`e`) justamente para a tela não pagar nada por padrão; aqui ela é
	// o assunto do passo. `listIndexes` é catálogo — responde em milissegundos.
	useEffect(() => {
		if (!dbName || collections.length === 0) return;
		void loadStats(dbName, key ? key.split(",") : [], {
			estimates: false,
			indexes: true,
		});
	}, [dbName, key, collections.length, loadStats]);

	const known = state.indexes.filter((i) => collections.includes(i.collection));
	const items = itemsFor(known);
	const selected = selectedIds(value, items);

	function apply(next: Set<string>) {
		// Tudo marcado volta a ser `true` no yml: mais legível, e continua valendo
		// para índices criados na origem depois deste momento.
		if (items.length > 0 && next.size === items.length) {
			onChange(true);
			return;
		}
		onChange(toEntries(next));
	}

	if (collections.length === 0)
		return (
			<Text color={theme.muted}>
				escolha as collections primeiro — os índices listados são os delas.
			</Text>
		);

	if (state.loadingStats && known.length === 0)
		return <Text color={theme.muted}>lendo os índices da origem…</Text>;

	return (
		<Box flexDirection="column">
			<Text color={theme.muted}>
				o sync copia dados, não índices. o que for marcado aqui é criado no
				destino (build custa tempo e disco).
			</Text>
			<Box marginTop={1}>
				<EntryPicker
					items={items}
					selected={selected}
					onToggle={(id) => {
						const next = new Set(selected);
						if (next.has(id)) next.delete(id);
						else next.add(id);
						apply(next);
					}}
					onSelectAll={(ids) => apply(new Set([...selected, ...ids]))}
					onClear={() => onChange(false)}
					onConfirm={onDone}
					onBack={onBack}
					focus={focused}
					visible={visibleRows}
					emptyLabel="as collections escolhidas não têm índice secundário"
					allLabel="marcar todos os índices"
				/>
			</Box>
		</Box>
	);
}

/** Um item por índice secundário — o `_id_` já existe no destino por definição. */
function itemsFor(known: CollIndexes[]): PickerItem[] {
	const items: PickerItem[] = [];

	for (const coll of known) {
		for (const idx of coll.indexes) {
			if (idx.name === "_id_") continue;
			items.push({
				id: `${coll.collection}${SEP}${idx.name}`,
				label: `${coll.collection} · ${idx.name}`,
				hint: describeKey(idx.key),
				tag: idx.ttl ? "TTL" : idx.unique ? "único" : undefined,
			});
		}
	}

	return items;
}

/** `{ data: -1, status: 1 }` → "data:-1 status:1" */
function describeKey(key: Record<string, unknown>): string {
	return Object.entries(key)
		.map(([field, dir]) => `${field}:${String(dir)}`)
		.join(" ");
}

function selectedIds(
	value: CopyIndexesOption,
	items: PickerItem[],
): Set<string> {
	if (value === true) return new Set(items.map((i) => i.id));
	if (value === false) return new Set();

	const ids = new Set<string>();
	for (const entry of value)
		for (const name of entry.indexes)
			ids.add(`${entry.collection}${SEP}${name}`);
	return ids;
}

function toEntries(ids: Set<string>): CopyIndexesOption {
	const byColl = new Map<string, string[]>();

	for (const id of ids) {
		const at = id.indexOf(SEP);
		if (at < 0) continue;
		const coll = id.slice(0, at);
		const name = id.slice(at + 1);
		const list = byColl.get(coll);
		if (list) list.push(name);
		else byColl.set(coll, [name]);
	}

	// Nenhum índice marcado é `false` — a forma canônica de "não copie índice".
	if (byColl.size === 0) return false;

	return Array.from(byColl, ([collection, indexes]) => ({
		collection,
		indexes: indexes.sort(),
	})).sort((a, b) => a.collection.localeCompare(b.collection));
}
