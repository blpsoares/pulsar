import type { Hint } from "./components/Shell";

/**
 * Fonte ÚNICA das teclas de cada camada.
 *
 * A barra de teclas cabe umas oito, e a nona simplesmente não existia para o
 * usuário. Com o `?` mostrando tudo, passa a haver duas listas do mesmo
 * assunto — e é assim que help de terminal apodrece: alguém acrescenta a tecla
 * no `useInput`, atualiza a barra, esquece da ajuda. Aqui existe uma lista só;
 * a barra é um filtro dela (`primary`), a ajuda é ela inteira, agrupada.
 */

export type KeyBinding = {
	keys: string;
	label: string;
	group: string;
	/** aparece na barra estreita do rodapé, além da ajuda */
	primary?: boolean;
};

export type Layer = "list" | "detail" | "form" | "logs" | "help";

export const GLOBAL_KEYS: KeyBinding[] = [
	{ keys: "?", label: "esta ajuda", group: "sempre" },
	{ keys: "esc", label: "fechar", group: "sempre" },
	{ keys: "ctrl+d", label: "sair da TUI", group: "sempre" },
];

export const KEYS: Record<Layer, KeyBinding[]> = {
	list: [
		{ keys: "↑↓", label: "navegar", group: "navegar", primary: true },
		{
			keys: "enter",
			label: "abrir o serviço",
			group: "navegar",
			primary: true,
		},
		{ keys: "n", label: "novo serviço", group: "serviço", primary: true },
		{ keys: "l", label: "logs", group: "serviço", primary: true },
		// iniciar/parar/reiniciar NÃO vivem aqui: são ações do ITEM, a um `enter`
		// de distância, na camada "detail" (Task 11 não as trata na lista — ver
		// task-10-report.md).
		{ keys: "R", label: "recarregar a lista", group: "serviço" },
		{ keys: "ctrl+c", label: "copiar o nome", group: "copiar" },
		{ keys: "m", label: "mouse on/off", group: "copiar" },
		{ keys: "q", label: "sair", group: "sair", primary: true },
	],
	detail: [
		{ keys: "i", label: "iniciar", group: "controlar", primary: true },
		{ keys: "p", label: "parar", group: "controlar", primary: true },
		{ keys: "t", label: "reiniciar", group: "controlar" },
		// "▶" não é uma tecla apertável — ninguém digita uma seta. A ação é `r`
		// (Task 12 trata o teclado do detalhe com essa tecla).
		{ keys: "r", label: "rodar agora aqui", group: "controlar", primary: true },
		{ keys: "b", label: "trocar inicialização", group: "configurar" },
		{ keys: "e", label: "editar", group: "configurar", primary: true },
		{ keys: "x", label: "remover", group: "configurar" },
		{ keys: "l", label: "logs", group: "ver", primary: true },
		{ keys: "v", label: "ver resultado / erro", group: "ver" },
		// Só aparece quando o serviço está "adotado" (sem registro do pulsar) —
		// reconstrói o registro a partir do supervisor (Task 5/`adopt.ts`).
		{ keys: "a", label: "adotar (gravar registro)", group: "configurar" },
		// Só aparece quando `boot: false` num serviço de modo contínuo (sync) —
		// habilita depois o passo com sudo que a instalação pulou.
		{ keys: "o", label: "ligar boot automático", group: "configurar" },
	],
	form: [
		{ keys: "↑↓", label: "campo", group: "navegar", primary: true },
		{ keys: "enter", label: "editar o campo", group: "navegar", primary: true },
		{ keys: "espaço", label: "marcar/desmarcar", group: "navegar" },
		{ keys: "/", label: "buscar na lista aberta", group: "navegar" },
		{ keys: "ctrl+s", label: "criar e subir", group: "gravar", primary: true },
		{ keys: "ctrl+o", label: "só criar", group: "gravar" },
	],
	logs: [
		{ keys: "↑↓", label: "rolar linha", group: "rolar", primary: true },
		{ keys: "PgUp/PgDn", label: "rolar página", group: "rolar" },
		{ keys: "g", label: "topo", group: "rolar" },
		{ keys: "G", label: "fim", group: "rolar" },
		{ keys: "f", label: "seguir", group: "rolar", primary: true },
		{ keys: "/", label: "buscar", group: "buscar", primary: true },
		{ keys: "n", label: "próxima ocorrência", group: "buscar" },
		{ keys: "N", label: "ocorrência anterior", group: "buscar" },
		{
			keys: "ctrl+c",
			label: "copiar a linha em foco",
			group: "copiar",
			primary: true,
		},
		{ keys: "Y", label: "copiar tudo que está na tela", group: "copiar" },
		{ keys: "m", label: "mouse off (seleção nativa)", group: "copiar" },
	],
	help: [],
};

export function hintsFor(layer: Layer): Hint[] {
	return KEYS[layer]
		.filter((binding) => binding.primary)
		.map(({ keys, label }) => ({ keys, label }));
}

export function helpFor(layer: Layer): { group: string; keys: KeyBinding[] }[] {
	const groups: { group: string; keys: KeyBinding[] }[] = [];

	for (const binding of KEYS[layer]) {
		const existing = groups.find((g) => g.group === binding.group);
		if (existing) existing.keys.push(binding);
		else groups.push({ group: binding.group, keys: [binding] });
	}

	groups.push({ group: "sempre", keys: GLOBAL_KEYS });
	return groups;
}
