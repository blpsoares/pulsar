import { Box, Text } from "ink";
import type { DbEntry } from "../../../core/inspect/inspectDb";
import { theme } from "../../theme";
import { EntryPicker, type PickerItem } from "../EntryPicker";

/**
 * Quais views recriar no destino.
 *
 * Views não são sincronizadas pelo change stream — são metadado (viewOn +
 * pipeline), sem documento e sem oplog. Ao recriar o destino do zero elas
 * simplesmente somem, e é por isso que escolher quais recriar merece um passo
 * próprio em vez de um toggle escondido no "avançado".
 *
 * O aviso da view órfã aparece na PRÓPRIA LINHA: uma view cuja base não está na
 * seleção de collections é criada no destino e responde vazio — falha silenciosa
 * clássica, que ninguém descobre lendo um resumo depois.
 */

export function ViewsStep({
	views,
	value,
	selectedCollections,
	onChange,
	onDone,
	onBack,
	focused,
	visibleRows,
}: {
	views: DbEntry[];
	value: boolean | string[];
	selectedCollections: string[];
	onChange: (next: boolean | string[]) => void;
	onDone: () => void;
	onBack: () => void;
	focused: boolean;
	visibleRows: number;
}) {
	const collections = new Set(selectedCollections);

	// `true` no yml quer dizer "todas, inclusive as criadas depois" — na tela
	// isso se mostra como tudo marcado.
	const selected = new Set(
		value === true
			? views.map((v) => v.name)
			: Array.isArray(value)
				? value
				: [],
	);

	const items: PickerItem[] = views.map((v) => {
		const orphan = Boolean(v.viewOn && !collections.has(v.viewOn));
		return {
			id: v.name,
			label: v.name,
			hint: v.viewOn
				? orphan
					? `sobre ${v.viewOn} — fora da seleção, responderá vazio`
					: `sobre ${v.viewOn}`
				: undefined,
			warn: orphan && selected.has(v.name),
		};
	});

	/**
	 * Marcar TODAS volta a gravar `true`, não a lista com todos os nomes: além de
	 * mais legível no yml, `true` continua pegando views criadas na origem depois
	 * deste momento — uma lista congelada não pegaria.
	 */
	function apply(next: Set<string>) {
		onChange(
			next.size === views.length && views.length > 0 ? true : Array.from(next),
		);
	}

	if (views.length === 0)
		return (
			<Box flexDirection="column">
				<Text color={theme.muted}>
					não há views na origem — nada a recriar no destino.
				</Text>
				<Box marginTop={1}>
					<Text color={theme.border}>enter segue para o próximo passo</Text>
				</Box>
			</Box>
		);

	return (
		<Box flexDirection="column">
			<Text color={theme.muted}>
				views são metadado: o sync não as replica, este passo recria as
				definições no destino.
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
					onClear={() => onChange([])}
					onConfirm={onDone}
					onBack={onBack}
					focus={focused}
					visible={visibleRows}
					emptyLabel="nenhuma view neste banco"
					allLabel="marcar todas as views"
				/>
			</Box>
		</Box>
	);
}
