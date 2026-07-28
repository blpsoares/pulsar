import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { detectConfigs } from "../../core/compose/detectConfigs";
import { loadConfigFile } from "../../core/config/loadConfig";
import {
	type BackendAvailability,
	detectBackends,
	preferredBackend,
} from "../../core/service/detect";
import { BASE_COMPOSE } from "../../core/service/dockerService";
import {
	buildPlan,
	controlService,
	type InstallResult,
	installService,
	type StepResult,
	serviceStatus,
	uninstallService,
} from "../../core/service/manager";
import type {
	Backend,
	InstallPlan,
	ServiceSpec,
	ServiceStatus,
} from "../../core/service/types";
import { Frame } from "../components/Frame";
import { Select } from "../components/Select";
import { theme } from "../theme";

/**
 * Rodar em background e subir no boot.
 *
 * A tela é honesta sobre o que cada backend consegue nesta máquina: o que não
 * está disponível aparece desabilitado com o motivo, e o plano completo
 * (arquivos que serão gravados + comandos que serão executados) é mostrado
 * ANTES de qualquer coisa acontecer. Instalar serviço é mexer no boot da
 * máquina do usuário — ele merece ver o que vai ser feito.
 */

type Step =
	| { name: "pick-config" }
	| { name: "pick-backend"; file: string }
	| { name: "plan"; file: string; backend: Backend }
	| { name: "result"; file: string; backend: Backend; result: InstallResult };

export function ServicesScreen({
	dir,
	onExit,
}: {
	dir: string;
	onExit: () => void;
}) {
	const [step, setStep] = useState<Step>({ name: "pick-config" });
	const [autostart, setAutostart] = useState(true);
	const [availability, setAvailability] = useState<
		BackendAvailability[] | null
	>(null);
	const [status, setStatus] = useState<ServiceStatus | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [actionLog, setActionLog] = useState<StepResult[]>([]);

	useEffect(() => {
		void detectBackends(existsSync(join(dir, BASE_COMPOSE))).then(
			setAvailability,
		);
	}, [dir]);

	const configs = detectConfigs(dir).filter((c) => c.kind !== "desconhecido");

	function specFor(file: string): ServiceSpec | null {
		const path = resolve(dir, file);
		const loaded = loadConfigFile(path);
		if (!loaded) return null;
		return {
			name: basename(file).replace(/\.ya?ml$/i, ""),
			mode: loaded.form.mode,
			configPath: path,
			workingDir: dir,
			autostart,
		};
	}

	useInput((input, key) => {
		if (busy) return;

		if (key.escape) {
			if (step.name === "pick-config") onExit();
			else if (step.name === "pick-backend") setStep({ name: "pick-config" });
			else if (step.name === "plan")
				setStep({ name: "pick-backend", file: step.file });
			else setStep({ name: "pick-config" });
			return;
		}

		if (step.name === "pick-backend" && input === "s") setAutostart((a) => !a);

		if (step.name === "plan") {
			const spec = specFor(step.file);
			if (!spec) return;

			if (key.return) {
				const plan = buildPlan(step.backend, spec);
				if ("error" in plan) return;
				setBusy("instalando…");
				void installService(plan, spec).then((result) => {
					setBusy(null);
					setStep({ ...step, name: "result", result });
					void refreshStatus(step.backend, spec);
				});
				return;
			}
			if (input === "x") {
				setBusy("removendo…");
				void uninstallService(step.backend, spec).then((results) => {
					setBusy(null);
					setActionLog(results);
					void refreshStatus(step.backend, spec);
				});
				return;
			}
			if (input === "i" || input === "p" || input === "t") {
				const action =
					input === "i" ? "start" : input === "p" ? "stop" : "restart";
				setBusy(`${action}…`);
				void controlService(step.backend, spec, action).then((r) => {
					setBusy(null);
					setActionLog([r]);
					void refreshStatus(step.backend, spec);
				});
			}
		}
	});

	async function refreshStatus(backend: Backend, spec: ServiceSpec) {
		setStatus(await serviceStatus(backend, spec));
	}

	// --- passo 1: escolher a config ---
	if (step.name === "pick-config")
		return (
			<Frame
				title="background e boot"
				subtitle={dir}
				hints={[
					{ keys: "↑↓", label: "navegar" },
					{ keys: "enter", label: "escolher" },
					{ keys: "esc", label: "voltar" },
				]}
			>
				<Text color={theme.muted}>Qual config vai virar serviço?</Text>
				<Box marginTop={1}>
					<Select
						items={configs.map((c) => ({
							value: c.file,
							label: c.file,
							hint: `${c.kind}${c.destDb ? ` → ${c.destDb}` : ""}`,
						}))}
						onSelect={(file) => setStep({ name: "pick-backend", file })}
						emptyMessage="nenhuma config nesta pasta — crie uma primeiro"
					/>
				</Box>
			</Frame>
		);

	// --- passo 2: escolher o backend ---
	if (step.name === "pick-backend") {
		const preferred = availability ? preferredBackend(availability) : null;
		return (
			<Frame
				title="background e boot · onde rodar"
				subtitle={step.file}
				hints={[
					{ keys: "enter", label: "escolher" },
					{ keys: "s", label: `iniciar no boot: ${autostart ? "sim" : "não"}` },
					{ keys: "esc", label: "voltar" },
				]}
			>
				{availability === null ? (
					<Text color={theme.muted}>checando o que existe nesta máquina…</Text>
				) : (
					<Box flexDirection="column">
						<Select
							items={availability.map((a) => ({
								value: a.backend,
								label:
									a.backend +
									(a.backend === preferred ? "  (recomendado aqui)" : ""),
								hint: a.available
									? describeBackend(a.backend)
									: `indisponível — ${a.reason}${a.fix ? ` · ${a.fix}` : ""}`,
								disabled: !a.available,
							}))}
							onSelect={(backend) => {
								setStep({ name: "plan", file: step.file, backend });
								const spec = specFor(step.file);
								if (spec) void refreshStatus(backend, spec);
							}}
							initialIndex={Math.max(
								0,
								availability.findIndex((a) => a.backend === preferred),
							)}
						/>
						<Box marginTop={1}>
							<Text color={autostart ? theme.ok : theme.muted}>
								{autostart ? "[x]" : "[ ]"} iniciar junto com o sistema
							</Text>
						</Box>
					</Box>
				)}
			</Frame>
		);
	}

	// --- passos 3 e 4: plano, instalação e controle ---
	const spec = specFor(step.file);
	if (!spec)
		return (
			<Frame
				title="background e boot"
				hints={[{ keys: "esc", label: "voltar" }]}
				status={{ text: `não consegui ler ${step.file}`, tone: "error" }}
			>
				<Text> </Text>
			</Frame>
		);

	const plan = buildPlan(step.backend, spec);

	return (
		<Frame
			title={`background · ${step.backend}`}
			subtitle={`${step.file} · ${spec.mode}`}
			hints={[
				{ keys: "enter", label: "instalar" },
				{ keys: "i/p/t", label: "iniciar/parar/reiniciar" },
				{ keys: "x", label: "remover" },
				{ keys: "esc", label: "voltar" },
			]}
			status={
				busy
					? { text: busy }
					: status
						? {
								text: `serviço ${status.name}: ${status.installed ? "instalado" : "não instalado"}${status.installed ? ` · ${status.running ? "rodando" : "parado"} · boot: ${status.enabled ? "sim" : "não"}` : ""}${status.detail ? ` · ${status.detail}` : ""}`,
								tone: status.running ? "ok" : undefined,
							}
						: undefined
			}
		>
			{"error" in plan ? (
				<Text color={theme.error}>✖ {plan.error}</Text>
			) : (
				<PlanView plan={plan} />
			)}

			{step.name === "result" ? <ResultView result={step.result} /> : null}

			{actionLog.length > 0 ? (
				<Box flexDirection="column" marginTop={1}>
					{actionLog.map((r) => (
						<Text
							key={r.step.cmd + r.step.args.join()}
							color={r.ok ? theme.ok : theme.error}
						>
							{r.ok ? "✔" : "✖"} {r.step.cmd} {r.step.args.join(" ")}
							{r.output ? ` — ${firstLine(r.output)}` : ""}
						</Text>
					))}
				</Box>
			) : null}
		</Frame>
	);
}

function PlanView({ plan }: { plan: InstallPlan }) {
	return (
		<Box flexDirection="column">
			<Text color={theme.accent}>arquivos que serão gravados</Text>
			{plan.files.map((f) => (
				<Text key={f.path} color={theme.muted}>
					{"  "}
					{f.path}
				</Text>
			))}

			<Box marginTop={1} flexDirection="column">
				<Text color={theme.accent}>comandos que serão executados</Text>
				{plan.steps.map((s) => (
					<Text key={s.cmd + s.args.join()} color={theme.muted}>
						{"  "}
						{s.cmd} {s.args.join(" ")}
						<Text color={theme.muted}> — {s.why}</Text>
					</Text>
				))}
			</Box>

			{plan.manualSteps.length > 0 ? (
				<Box marginTop={1} flexDirection="column">
					<Text color={theme.warn}>
						você precisa rodar à mão (pedem sudo — a TUI não executa)
					</Text>
					{plan.manualSteps.map((s) => (
						<Text key={s.cmd + s.args.join()}>
							{"  "}
							<Text color={theme.label}>
								{s.cmd} {s.args.join(" ")}
							</Text>
							<Text color={theme.muted}> — {s.why}</Text>
						</Text>
					))}
				</Box>
			) : null}

			{plan.notes.length > 0 ? (
				<Box marginTop={1} flexDirection="column">
					{plan.notes.map((n) => (
						<Text key={n} color={theme.muted}>
							· {n}
						</Text>
					))}
				</Box>
			) : null}
		</Box>
	);
}

function ResultView({ result }: { result: InstallResult }) {
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text color={result.ok ? theme.ok : theme.error}>
				{result.ok
					? "✔ instalado"
					: "✖ a instalação parou num passo obrigatório"}
			</Text>
			{result.results.map((r) => (
				<Text
					key={r.step.cmd + r.step.args.join()}
					color={r.ok ? theme.muted : theme.error}
				>
					{"  "}
					{r.ok ? "✔" : "✖"} {r.step.cmd} {r.step.args.join(" ")}
					{r.output ? ` — ${firstLine(r.output)}` : ""}
				</Text>
			))}
		</Box>
	);
}

function describeBackend(backend: Backend): string {
	switch (backend) {
		case "systemd":
			return "unit de usuário em ~/.config/systemd/user (sem sudo)";
		case "launchd":
			return "LaunchAgent em ~/Library/LaunchAgents (sobe no login)";
		case "pm2":
			return "gerenciador de processos, igual em Linux e macOS";
		case "docker":
			return "container com cerca de RAM/CPU, herdando o compose base";
	}
}

function firstLine(text: string): string {
	return text.split("\n")[0]?.slice(0, 100) ?? "";
}
