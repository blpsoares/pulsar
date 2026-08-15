import { Text, useInput } from "ink";
import { useState } from "react";
import type { ServiceRow } from "../../core/state/reconcile";
import type { ServiceRecord } from "../../core/state/registry";
import { Overlay } from "../components/Overlay";
import { isMouseInput } from "../mouse/parse";
import { theme } from "../theme";

/**
 * O overlay de detalhe: onde as ações do serviço moram, coladas no item.
 *
 * É a peça central do redesenho — antes os verbos (iniciar/parar/editar…)
 * viviam numa barra do lado esquerdo, desconectados de qual serviço estava
 * selecionado do lado direito. Aqui `enter` sobre uma linha abre ESTE overlay
 * e toda ação parte dele.
 */

/**
 * O resultado de um one-shot, em linguagem de gente.
 *
 * Os nomes dos contadores mudam por modo (um ttl não "insere documentos",
 * cria índices; um migrate não expõe contagem de docs porque roda o
 * mongodump como processo filho), então a tradução é por modo — mostrar
 * `materialized: 0` para um sync seria ruído.
 */
export function formatStats(record: ServiceRecord): string[] {
	const stats = record.lastRun?.stats ?? {};
	const labels: Record<string, Record<string, string>> = {
		sync: {
			collections: "collections",
			resumed: "retomadas",
			dumped: "dump completo",
			docs: "documentos copiados",
			indexes: "índices criados",
			views: "views criadas",
		},
		migrate: {
			collections: "collections",
			docs: "documentos copiados",
		},
		ttl: {
			collections: "collections",
			indexes: "índices TTL criados",
			materialized: "documentos com _created",
		},
	};

	const dictionary = labels[record.mode] ?? {};
	return Object.entries(stats).map(
		([key, value]) =>
			`${dictionary[key] ?? key}: ${value.toLocaleString("pt-BR")}`,
	);
}

/**
 * Formata `endedAt` por extenso, em vez de deixar o painel de resultado
 * parecer o estado ATUAL do serviço.
 *
 * `switchBackend` (Task 9) preserva `lastRun` ao trocar de supervisor — o
 * dado continua correto como fato histórico, mas passa a descrever uma
 * execução sob o backend ANTIGO, e o registro não guarda em qual backend
 * cada execução rodou (não dá pra saber se ESTA é a que ficou obsoleta sem
 * inventar um campo novo). A saída barata e honesta: sempre datar o
 * resultado, para o texto ler "isto é de tal hora" em vez de "isto é agora".
 */
function formatResultTimestamp(record: ServiceRecord): string | null {
	const endedAt = record.lastRun?.endedAt;
	if (!endedAt) return null;
	const date = new Date(endedAt);
	if (Number.isNaN(date.getTime())) return null;
	return `resultado de ${date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`;
}

export function ServiceDetail({
	row,
	columns,
	rows,
	busy,
	onClose,
	onControl,
	onRun,
	onEdit,
	onSwitchBackend,
	onLogs,
	onRemove,
	onAdopt,
	onEnableBoot,
}: {
	row: ServiceRow;
	columns: number;
	rows: number;
	busy: string | null;
	onClose: () => void;
	onControl: (action: "start" | "stop" | "restart") => void;
	onRun: () => void;
	onEdit: () => void;
	onSwitchBackend: () => void;
	onLogs: () => void;
	onRemove: () => void;
	/**
	 * Reconstrói o registro a partir do supervisor (`adoptFromSystemd` /
	 * `adoptFromDocker`, Task 5) e grava com `writeRecord`. Só existe tecla e
	 * botão pra isso quando `row.state === "adopted"` — sem registro não há o
	 * que iniciar/editar/remover pelo pulsar.
	 */
	onAdopt: () => void;
	/**
	 * Habilita o boot depois, para quem instalou pulando o passo com sudo
	 * (`boot: false` gravado de propósito, não um estado "pendente" inventado).
	 * Opcional: só faz sentido oferecer quando o modo normalmente sobe no boot
	 * (sync) e o registro existe.
	 */
	onEnableBoot?: () => void;
}) {
	const [showResult, setShowResult] = useState(false);
	const record = row.record;
	const adopted = row.state === "adopted";
	const bootPending = Boolean(record && record.mode === "sync" && !record.boot);

	useInput((input, key) => {
		if (isMouseInput(input)) return;
		if (key.escape) {
			if (showResult) setShowResult(false);
			else onClose();
			return;
		}
		if (busy) return; // uma operação por vez

		if (adopted) {
			// Sem registro só há uma ação de verdade: adotar. O resto (iniciar,
			// editar, remover…) precisa do modo/config/workingDir que só o
			// registro guarda.
			if (input === "a") onAdopt();
			if (input === "l") onLogs();
			return;
		}

		if (input === "i") onControl("start");
		if (input === "p") onControl("stop");
		if (input === "t") onControl("restart");
		if (input === "r") onRun();
		if (input === "e") onEdit();
		if (input === "b") onSwitchBackend();
		if (input === "l") onLogs();
		if (input === "x") onRemove();
		if (input === "v") setShowResult(true);
		if (input === "o" && bootPending && onEnableBoot) onEnableBoot();
	});

	if (showResult && record) {
		const timestamp = formatResultTimestamp(record);
		return (
			<Overlay title={`resultado · ${row.name}`} columns={columns} rows={rows}>
				{timestamp ? <Text color={theme.muted}>{timestamp}</Text> : null}
				{timestamp ? <Text> </Text> : null}
				{record.lastRun?.status === "error" ? (
					<Text color={theme.error}>
						{record.lastRun.error ?? "sem detalhe"}
					</Text>
				) : (
					formatStats(record).map((line) => <Text key={line}>{line}</Text>)
				)}
			</Overlay>
		);
	}

	return (
		<Overlay
			title={row.name}
			columns={columns}
			rows={rows}
			footer={busy ? <Text color={theme.warn}>{busy}</Text> : undefined}
		>
			<Text color={theme.muted}>
				{record
					? `${record.mode} · ${record.config} · ${record.backend}`
					: "sem registro — adotado do supervisor"}
			</Text>
			{record ? (
				<Text color={theme.muted}>boot: {record.boot ? "sim" : "não"}</Text>
			) : null}
			<Text> </Text>
			{record?.lastRun?.status === "error" ? (
				<Text color={theme.error}>
					✗ última execução falhou — v mostra o erro
				</Text>
			) : record?.lastRun?.status === "ok" ? (
				<Text color={theme.ok}>✓ concluído — v mostra o resultado</Text>
			) : null}
			<Text> </Text>
			{adopted ? (
				<>
					<Action tecla="a" label="adotar (grava registro do pulsar)" />
					<Action tecla="l" label="logs" />
				</>
			) : (
				<>
					<Action tecla="i" label="iniciar" />
					<Action tecla="p" label="parar" />
					<Action tecla="t" label="reiniciar" />
					<Action tecla="r" label="rodar agora aqui (1º plano, ao vivo)" />
					<Action tecla="b" label="trocar modo de inicialização" />
					<Action tecla="l" label="logs" />
					<Action tecla="e" label="editar" />
					<Action tecla="x" label="remover" />
					{record?.lastRun ? (
						<Action tecla="v" label="ver resultado / erro" />
					) : null}
					{bootPending && onEnableBoot ? (
						<Action tecla="o" label="ligar boot automático" />
					) : null}
				</>
			)}
		</Overlay>
	);
}

function Action({ tecla, label }: { tecla: string; label: string }) {
	return (
		<Text>
			<Text color={theme.accent} bold>
				{`  [${tecla}] `}
			</Text>
			<Text>{label}</Text>
		</Text>
	);
}
