import { basename } from "node:path";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import {
	type DiscoveredService,
	discoverServices,
} from "../../core/service/discover";
import { controlService } from "../../core/service/manager";
import type { ServiceSpec } from "../../core/service/types";
import { Select } from "../components/Select";
import {
	type Chip,
	layout,
	Panel,
	Shell,
	SIDEBAR_WIDTH,
	Stat,
} from "../components/Shell";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { isMouseInput } from "../mouse/parse";
import { glyph, theme } from "../theme";

/**
 * O que está rodando em background AGORA, em qualquer supervisor.
 *
 * Responde de frente à pergunta "isso aqui está no ar?" — que antes só dava
 * para responder um serviço por vez, partindo da config. A varredura olha
 * systemd, pm2, docker e launchd; o que não estiver instalado simplesmente não
 * contribui.
 */

export function RunningScreen({
	dir,
	onExit,
	onInstall,
	onLogs,
}: {
	dir: string;
	onExit: () => void;
	/** ir para a tela de background (escolher backend, ver plano, remover) */
	onInstall: () => void;
	onLogs: () => void;
}) {
	const { columns, rows } = useTerminalSize();
	const l = layout(columns, rows);

	const [services, setServices] = useState<DiscoveredService[] | null>(null);
	const [index, setIndex] = useState(0);
	const [busy, setBusy] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setServices(await discoverServices());
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const selected = services?.[Math.min(index, (services?.length ?? 1) - 1)];

	async function control(action: "start" | "stop" | "restart") {
		if (!selected) return;
		setBusy(`${action}…`);

		// O controle precisa de um ServiceSpec, mas aqui partimos do serviço
		// DESCOBERTO: o nome já vem no formato do supervisor, então basta desfazer
		// o prefixo para reconstruir o `name` que o manager espera.
		const spec: ServiceSpec = {
			name: selected.name.replace(/^pulsar-/, "").replace(/^com\.pulsar\./, ""),
			mode: "sync",
			configPath: "",
			workingDir: dir,
			autostart: false,
		};

		const result = await controlService(selected.backend, spec, action);
		setBusy(null);
		setMessage(
			result.ok
				? `${action} ok em ${selected.name}`
				: `falhou: ${result.output.split("\n")[0] ?? ""}`,
		);
		await refresh();
	}

	useInput((input, key) => {
		if (isMouseInput(input) || busy) return;

		if (key.escape) {
			onExit();
			return;
		}
		if (input === "R") {
			void refresh();
			return;
		}
		if (input === "n") {
			onInstall();
			return;
		}
		if (input === "l") {
			onLogs();
			return;
		}
		if (input === "i") void control("start");
		if (input === "p") void control("stop");
		if (input === "t") void control("restart");
	});

	const running = services?.filter((s) => s.running).length ?? 0;
	const chips: Chip[] = [
		{
			label: "no ar",
			value: services === null ? "…" : String(running),
			tone: running > 0 ? "ok" : "muted",
		},
		{
			label: "instalados",
			value: services === null ? "…" : String(services.length),
			tone: "muted",
		},
	];

	return (
		<Shell
			chips={chips}
			columns={columns}
			rows={rows}
			notice={
				busy
					? { text: busy }
					: message
						? {
								text: message,
								tone: message.startsWith("falhou") ? "error" : "ok",
							}
						: undefined
			}
			copy={() => selected?.name ?? null}
			hints={[
				{ keys: "↑↓", label: "serviço" },
				{ keys: "i/p/t", label: "iniciar/parar/reiniciar" },
				{ keys: "n", label: "instalar outro" },
				{ keys: "l", label: "logs" },
				{ keys: "R", label: "atualizar" },
				{ keys: "esc", label: "voltar" },
			]}
		>
			<Panel title="ações" width={SIDEBAR_WIDTH} height={l.body}>
				<Text color={theme.muted} wrap="wrap">
					i inicia · p para · t reinicia o serviço sob o cursor.
				</Text>
				<Box marginTop={1}>
					<Text color={theme.muted} wrap="wrap">
						n abre a tela de background para instalar uma config nova ou remover
						um serviço.
					</Text>
				</Box>
			</Panel>

			<Panel
				title={`rodando em background · ${basename(dir)}`}
				width={l.center}
				height={l.body}
				focused
			>
				{services === null ? (
					<Text color={theme.muted}>procurando serviços…</Text>
				) : services.length === 0 ? (
					<Box flexDirection="column">
						<Text color={theme.muted}>
							nenhum serviço do pulsar instalado nesta máquina.
						</Text>
						<Text color={theme.muted}>
							tecle <Text color={theme.accent}>n</Text> para instalar um, ou use{" "}
							<Text color={theme.accent}>b</Text> sobre uma config na tela
							inicial.
						</Text>
					</Box>
				) : (
					<Select
						items={services.map((service) => ({
							value: service.name,
							label: `${service.running ? glyph.dot : glyph.unchecked} ${service.name}`,
							hint: `${service.backend} · ${service.running ? "no ar" : "parado"}${
								service.enabled ? " · boot" : ""
							}${service.detail ? ` · ${service.detail}` : ""}`,
						}))}
						onSelect={() => void control(selected?.running ? "stop" : "start")}
						onHighlight={(_value, i) => setIndex(i)}
						visible={l.panelRows - 1}
					/>
				)}
			</Panel>

			{l.aside > 0 ? (
				<Panel title="serviço" width={l.aside} height={l.body}>
					{selected ? (
						<Box flexDirection="column">
							<Text color={theme.accent} bold wrap="truncate-end">
								{selected.name}
							</Text>
							<Box marginTop={1} flexDirection="column">
								<Stat
									label="backend"
									value={selected.backend}
									width={l.aside}
								/>
								<Stat
									label="estado"
									value={selected.running ? "no ar" : "parado"}
									width={l.aside}
									tone={selected.running ? "ok" : "warn"}
								/>
								<Stat
									label="no boot"
									value={selected.enabled ? "sim" : "não"}
									width={l.aside}
									tone={selected.enabled ? "ok" : "muted"}
								/>
							</Box>
							{selected.detail ? (
								<Box marginTop={1}>
									<Text color={theme.muted} wrap="wrap">
										{selected.detail}
									</Text>
								</Box>
							) : null}
						</Box>
					) : (
						<Text color={theme.muted}>—</Text>
					)}
				</Panel>
			) : null}
		</Shell>
	);
}
