import { relative, resolve } from "node:path";
import { useApp } from "ink";
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
	| { name: "logs" }
	| { name: "services" };

export function App({ dir }: { dir: string }) {
	const [route, setRoute] = useState<Route>({ name: "home" });
	const { exit } = useApp();

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
								setRoute({ name: "logs" });
								break;
							case "services":
								setRoute({ name: "services" });
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
			return <LogsScreen dir={dir} onExit={() => setRoute({ name: "home" })} />;

		case "services":
			return (
				<ServicesScreen dir={dir} onExit={() => setRoute({ name: "home" })} />
			);
	}
}
