import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import {
	type DetectedConfig,
	detectConfigs,
} from "../../core/compose/detectConfigs";
import { Frame } from "../components/Frame";
import { Select, type SelectItem } from "../components/Select";
import { theme } from "../theme";

/**
 * Tela inicial: as configs que já existem na pasta atual, mais as ações
 * globais.
 *
 * Reusa o `detectConfigs` do `compose up` — ele já sabe classificar um yml do
 * pulsar por `command.sync|migrate|ttl` e extrair os bancos. Um segundo
 * detector aqui seria uma segunda verdade sobre o que é uma config válida.
 */

type Action =
	| { type: "new" }
	| { type: "open"; file: string }
	| { type: "run"; file: string }
	| { type: "logs" }
	| { type: "services" }
	| { type: "quit" };

export function Home({
	dir,
	onAction,
	notice,
}: {
	dir: string;
	onAction: (action: Action) => void;
	notice?: string;
}) {
	const [reloadKey, setReloadKey] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey é a dependência — incrementá-lo é o que relê o diretório
	const configs = useMemo(
		() => detectConfigs(dir).filter((c) => c.kind !== "desconhecido"),
		[dir, reloadKey],
	);

	const [mode, setMode] = useState<"menu" | "pick-run" | "pick-open">("menu");

	useInput((input, key) => {
		if (input === "r" && mode === "menu") {
			setReloadKey((k) => k + 1);
			return;
		}
		if (key.escape && mode !== "menu") setMode("menu");
		else if (input === "q" && mode === "menu") onAction({ type: "quit" });
	});

	if (mode !== "menu") {
		const picking = mode === "pick-run" ? "rodar" : "editar";
		return (
			<Frame
				title={`escolher config para ${picking}`}
				subtitle={dir}
				hints={[
					{ keys: "↑↓", label: "navegar" },
					{ keys: "enter", label: picking },
					{ keys: "esc", label: "voltar" },
				]}
			>
				<Select
					items={configItems(configs)}
					onSelect={(file) => {
						setMode("menu");
						onAction(
							mode === "pick-run"
								? { type: "run", file }
								: { type: "open", file },
						);
					}}
					emptyMessage="nenhuma config do pulsar nesta pasta"
					visible={12}
				/>
			</Frame>
		);
	}

	const items: SelectItem<Action>[] = [
		{
			value: { type: "new" },
			label: "criar config",
			hint: "form guiado: modo, bancos, collections",
		},
		{
			value: { type: "run" as const, file: "" },
			label: "rodar",
			hint: "dispara uma config existente",
			disabled: configs.length === 0,
		},
		{
			value: { type: "open" as const, file: "" },
			label: "editar config",
			hint: "abre um yml já criado",
			disabled: configs.length === 0,
		},
		{
			value: { type: "services" },
			label: "background e boot",
			hint: "systemd / launchd / pm2 / docker",
		},
		{ value: { type: "logs" }, label: "logs", hint: "ao vivo e gravados" },
		{ value: { type: "quit" }, label: "sair", hint: "" },
	];

	return (
		<Frame
			title="início"
			subtitle={dir}
			hints={[
				{ keys: "↑↓", label: "navegar" },
				{ keys: "enter", label: "abrir" },
				{ keys: "r", label: "recarregar" },
				{ keys: "q", label: "sair" },
			]}
			status={notice ? { text: notice, tone: "ok" } : undefined}
		>
			<Box flexDirection="column">
				<Select
					items={items}
					onSelect={(action) => {
						if (action.type === "run") setMode("pick-run");
						else if (action.type === "open") setMode("pick-open");
						else onAction(action);
					}}
				/>

				<Box flexDirection="column" marginTop={1}>
					<Text color={theme.muted}>
						{configs.length} config{configs.length === 1 ? "" : "s"} nesta pasta
					</Text>
					{configs.slice(0, 5).map((c) => (
						<Text key={c.file} color={theme.muted}>
							{"  "}
							{c.file} · {c.kind}
							{c.destDb
								? ` → ${c.destDb}`
								: c.sourceDb
									? ` · ${c.sourceDb}`
									: ""}
						</Text>
					))}
					{configs.length > 5 ? (
						<Text color={theme.muted}>
							{"  "}…e mais {configs.length - 5}
						</Text>
					) : null}
				</Box>
			</Box>
		</Frame>
	);
}

function configItems(configs: DetectedConfig[]): SelectItem<string>[] {
	return configs.map((c) => ({
		value: c.file,
		label: c.file,
		hint: `${c.kind}${c.destDb ? ` → ${c.destDb}` : c.sourceDb ? ` · ${c.sourceDb}` : ""}`,
	}));
}
