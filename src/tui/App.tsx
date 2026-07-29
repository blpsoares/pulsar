import { relative, resolve } from "node:path";
import { useApp, useInput } from "ink";
import { useState } from "react";
import type { FormState } from "../core/config/formState";
import {
	type CollectionEntryRaw,
	loadConfigFile,
} from "../core/config/loadConfig";
import { Home } from "./screens/Home";
import { LogsScreen } from "./screens/Logs";
import { RunnerScreen } from "./screens/Runner";
import { ServicesScreen } from "./screens/Services";
import { Wizard } from "./screens/Wizard";

/**
 * Roteador da TUI. Uma tela por vez, estado de rota aqui em cima.
 *
 * Não existe biblioteca de rotas: o app tem cinco telas e uma navegação em
 * árvore rasa. Um `useState` com união discriminada dá o mesmo resultado sem
 * dependência nova, e o TypeScript verifica os parâmetros de cada rota.
 */

type Route =
	| { name: "home"; notice?: string }
	| {
			name: "wizard";
			form?: FormState;
			preserved?: Map<string, CollectionEntryRaw>;
			path?: string;
	  }
	| { name: "runner"; file: string }
	// `file` vem preenchido quando a ação partiu de uma config selecionada na
	// tela inicial — a tela pula direto para ela em vez de pedir de novo.
	| { name: "logs"; file?: string }
	| { name: "services"; file?: string };

export function App({ dir }: { dir: string }) {
	const [route, setRoute] = useState<Route>({ name: "home" });
	const { exit } = useApp();

	/**
	 * Saída global — Ctrl+C e Ctrl+D, de QUALQUER tela.
	 *
	 * O `render()` roda com `exitOnCtrlC: false` para que um sync disparado pela
	 * TUI receba SIGTERM (e grave o resume token) antes do processo morrer. Sem
	 * este handler, porém, desligar o atalho do ink deixa a TUI sem saída
	 * nenhuma: as telas internas só tratam `esc`, e `esc` na tela inicial não
	 * encerra. O `exit()` desmonta os componentes, e é o desmonte que dispara o
	 * SIGTERM no filho em `useProcess`.
	 */
	useInput((input, key) => {
		if (key.ctrl && (input === "c" || input === "d")) exit();
	});

	function openConfig(file: string) {
		const path = resolve(dir, file);
		const loaded = loadConfigFile(path);
		if (!loaded) {
			setRoute({
				name: "home",
				notice: `não consegui interpretar ${file} como config do pulsar`,
			});
			return;
		}
		setRoute({
			name: "wizard",
			form: loaded.form,
			preserved: loaded.preservedEntries,
			// Caminho relativo quando o arquivo está na pasta aberta: é o que cabe
			// no campo da tela de revisão sem estourar a linha. A gravação resolve
			// contra o cwd, que é essa mesma pasta.
			path: relative(dir, path) || path,
		});
	}

	switch (route.name) {
		case "home":
			return (
				<Home
					dir={dir}
					notice={route.notice}
					onAction={(action) => {
						switch (action.type) {
							case "new":
								setRoute({ name: "wizard" });
								break;
							case "open":
								openConfig(action.file);
								break;
							case "run":
								setRoute({ name: "runner", file: resolve(dir, action.file) });
								break;
							case "logs":
								setRoute({ name: "logs", file: action.file });
								break;
							case "services":
								setRoute({ name: "services", file: action.file });
								break;
							case "quit":
								exit();
								break;
						}
					}}
				/>
			);

		case "wizard":
			return (
				<Wizard
					initialForm={route.form}
					preserved={route.preserved}
					existingPath={route.path}
					onExit={() => setRoute({ name: "home" })}
					onRun={(file) => setRoute({ name: "runner", file })}
				/>
			);

		case "runner":
			return (
				<RunnerScreen
					file={route.file}
					onExit={() => setRoute({ name: "home" })}
					onInstallService={() => setRoute({ name: "services" })}
				/>
			);

		case "logs":
			return (
				<LogsScreen
					dir={dir}
					file={route.file}
					onExit={() => setRoute({ name: "home" })}
				/>
			);

		case "services":
			return (
				<ServicesScreen
					dir={dir}
					file={route.file}
					onExit={() => setRoute({ name: "home" })}
				/>
			);
	}
}
