import { Box, Text } from "ink";
import { useEffect } from "react";
import { CollectionPicker } from "../../components/CollectionPicker";
import type { useInspector } from "../../hooks/useInspector";
import { theme } from "../../theme";
import type { EstimateOptions } from "./EstimatesPanel";

/**
 * Escolha das collections. Só a lista — os números do "vai ser enviado" moram
 * no painel de contexto do wizard, e as opções de estimativa na sidebar.
 *
 * A separação existe para o cockpit funcionar: lista, opções e resumo ficam
 * visíveis ao mesmo tempo, cada um no seu painel, em vez de se cobrirem.
 */

export function CollectionsStep({
	dbName,
	selected,
	onChange,
	inspector,
	options,
	onOpenEstimates,
	onDone,
	onBack,
	focused,
	visibleRows,
}: {
	dbName: string;
	selected: string[];
	onChange: (names: string[]) => void;
	inspector: ReturnType<typeof useInspector>;
	options: EstimateOptions;
	onOpenEstimates: () => void;
	onDone: () => void;
	onBack: () => void;
	focused: boolean;
	visibleRows: number;
}) {
	const { state, loadStats, exactCount } = inspector;

	const entries = state.overview?.collections ?? [];
	// Assinatura da lista: string estável entre renders, ao contrário do array,
	// que é recriado a cada render e faria o efeito rodar em loop.
	const entriesKey = entries.map((e) => e.name).join(",");
	const selectedSet = new Set(selected);

	useEffect(() => {
		if (!options.enabled) return;
		const wantEstimates = options.docs || options.size;
		if (!wantEstimates && !options.indexes) return;

		void loadStats(dbName, entriesKey ? entriesKey.split(",") : [], {
			estimates: wantEstimates,
			indexes: options.indexes,
		});
	}, [
		options.enabled,
		options.docs,
		options.size,
		options.indexes,
		dbName,
		loadStats,
		entriesKey,
	]);

	if (entries.length === 0)
		return (
			<Text color={theme.muted}>
				nenhuma collection em {dbName} (ou a listagem ainda não voltou)
			</Text>
		);

	return (
		<Box flexDirection="column">
			<CollectionPicker
				entries={entries}
				selected={selectedSet}
				onToggle={(name) =>
					onChange(
						selectedSet.has(name)
							? selected.filter((n) => n !== name)
							: [...selected, name],
					)
				}
				onSelectAll={(names) =>
					onChange(Array.from(new Set([...selected, ...names])))
				}
				onClear={() => onChange([])}
				onConfirm={onDone}
				onBack={onBack}
				onOpenEstimates={onOpenEstimates}
				onExactCount={(name) => void exactCount(dbName, name)}
				estimates={state.estimates}
				indexes={state.indexes}
				columns={{
					docs: options.enabled && options.docs,
					size: options.enabled && options.size,
					indexes: options.enabled && options.indexes,
				}}
				focus={focused}
				visible={visibleRows}
			/>
		</Box>
	);
}
