import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { formatBytes, formatCount } from "../../../core/inspect/collStats";
import { buildTransferPlan, type TuiMode } from "../../../core/inspect/summary";
import { CollectionPicker } from "../../components/CollectionPicker";
import type { useInspector } from "../../hooks/useInspector";
import { theme } from "../../theme";
import {
	DEFAULT_ESTIMATE_OPTIONS,
	type EstimateOptions,
	EstimatesPanel,
} from "./EstimatesPanel";

/**
 * Escolha das collections + o painel de "o que vai ser enviado".
 *
 * O resumo embaixo é recalculado a cada tecla a partir do que já foi coletado,
 * e diz explicitamente quando o número é aproximado. A intenção é que ninguém
 * dispare um sync sem ter visto o tamanho do que pediu.
 */

type Props = {
	mode: TuiMode;
	dbName: string;
	selected: string[];
	onChange: (names: string[]) => void;
	inspector: ReturnType<typeof useInspector>;
	copyIndexes: boolean;
	copyViews: boolean | string[];
	onDone: () => void;
	onBack: () => void;
};

export function CollectionsStep({
	mode,
	dbName,
	selected,
	onChange,
	inspector,
	copyIndexes,
	copyViews,
	onDone,
	onBack,
}: Props) {
	const [options, setOptions] = useState<EstimateOptions>(
		DEFAULT_ESTIMATE_OPTIONS,
	);
	const [panelOpen, setPanelOpen] = useState(false);
	const { state, loadStats, exactCount } = inspector;

	const entries = state.overview?.collections ?? [];
	// Assinatura da lista: string estável entre renders, ao contrário do array,
	// que é recriado toda vez e dispararia o efeito em loop.
	const entriesKey = entries.map((e) => e.name).join(",");
	const views = state.overview?.views ?? [];
	const selectedSet = new Set(selected);

	// Recarrega quando o usuário muda o QUE quer ver. A lista entra pela
	// assinatura (`entriesKey`), não pelo array: o array é recriado a cada
	// render e faria o efeito rodar em loop.
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

	const plan = buildTransferPlan({
		mode,
		selected,
		estimates: state.estimates,
		indexes: state.indexes,
		sourceViews: views,
		copyIndexes,
		copyViews,
	});

	return (
		<Box flexDirection="column">
			<Box>
				<Text color={theme.muted}>
					banco <Text color={theme.label}>{dbName}</Text> · {entries.length}{" "}
					collections · {views.length} views
				</Text>
			</Box>

			<Box marginTop={1}>
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
					onOpenEstimates={() => setPanelOpen(true)}
					onExactCount={(name) => void exactCount(dbName, name)}
					estimates={state.estimates}
					indexes={state.indexes}
					columns={{
						docs: options.enabled && options.docs,
						size: options.enabled && options.size,
						indexes: options.enabled && options.indexes,
					}}
					focus={!panelOpen}
				/>
			</Box>

			{panelOpen ? (
				<Box marginTop={1}>
					<EstimatesPanel
						options={options}
						onChange={setOptions}
						onClose={() => setPanelOpen(false)}
						loading={state.loadingStats}
					/>
				</Box>
			) : (
				<PlanSummary
					plan={plan}
					loading={state.loadingStats}
					showNumbers={options.enabled}
				/>
			)}
		</Box>
	);
}

function PlanSummary({
	plan,
	loading,
	showNumbers,
}: {
	plan: ReturnType<typeof buildTransferPlan>;
	loading: boolean;
	showNumbers: boolean;
}) {
	const approx = plan.approximate ? "~" : "";

	return (
		<Box flexDirection="column" marginTop={1}>
			<Box>
				<Text color={theme.accent}>vai ser enviado: </Text>
				<Text>
					{plan.collections} collections
					{showNumbers ? (
						<Text>
							{" · "}
							{approx}
							{formatCount(plan.docs)} docs{" · "}
							{approx}
							{formatBytes(plan.dataSize)}
						</Text>
					) : null}
					{plan.indexes > 0 ? (
						<Text>
							{" · "}
							{plan.indexes} índices
						</Text>
					) : null}
					{plan.views > 0 ? (
						<Text>
							{" · "}
							{plan.views} views
						</Text>
					) : null}
				</Text>
				{loading ? <Text color={theme.muted}> atualizando…</Text> : null}
			</Box>

			{showNumbers && plan.approximate ? (
				<Text color={theme.muted}>
					~ = estimativa de metadata; `c` conta a collection sob o cursor de
					verdade
				</Text>
			) : null}

			{plan.warnings.map((w) => (
				<Text key={w} color={theme.warn}>
					⚠ {w}
				</Text>
			))}
		</Box>
	);
}
