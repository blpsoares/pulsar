import { type DOMElement, useInput } from "ink";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	DISABLE_MOUSE,
	ENABLE_MOUSE,
	isMouseInput,
	parseMouse,
	type TerminalMouseEvent,
} from "./parse";

/**
 * Mouse na TUI: cliques e roda, com hit-testing sobre a árvore do ink.
 *
 * Como funciona: cada área clicável se registra com um `ref`. Na hora do
 * clique, a posição ABSOLUTA de cada área é calculada somando os offsets do
 * yoga (`getComputedLeft/Top`) subindo até a raiz — foi verificado que isso
 * bate exatamente com o que aparece na tela. Ganha a menor área que contém o
 * ponto, para um item dentro de um painel vencer o painel.
 *
 * TRADEOFF que o usuário precisa saber: com o rastreamento ligado, o terminal
 * entrega os cliques para a aplicação e a seleção de texto nativa (arrastar o
 * mouse) para de funcionar. Quase todo terminal mantém a seleção com SHIFT
 * pressionado (iTerm2: Option). Por isso existe o toggle: `m` desliga o mouse
 * e devolve a seleção nativa por completo.
 *
 * SHIFT é tratado como "passa direto" (ver `dispatch`): é o que faz o gesto de
 * selecionar texto funcionar mesmo nos terminais que não fazem o override
 * sozinhos.
 */

export type ClickInfo = {
	/** linha clicada DENTRO da área (0 = primeira linha da área) */
	row: number;
	/** coluna clicada dentro da área */
	column: number;
	event: TerminalMouseEvent;
};

export type Region = {
	id: number;
	ref: RefObject<DOMElement | null>;
	onClick?: (info: ClickInfo) => void;
	onWheel?: (direction: -1 | 1, info: ClickInfo) => void;
};

type MouseContextValue = {
	enabled: boolean;
	toggle: () => void;
	register: (region: Region) => () => void;
};

const MouseContext = createContext<MouseContextValue | null>(null);

export function MouseProvider({ children }: { children: ReactNode }) {
	const [enabled, setEnabled] = useState(true);
	const regions = useRef(new Map<number, Region>());
	const nextId = useRef(0);

	const register = useCallback((region: Region) => {
		const id = nextId.current++;
		regions.current.set(id, { ...region, id });
		return () => {
			regions.current.delete(id);
		};
	}, []);

	useEffect(() => {
		if (!enabled || !process.stdout.isTTY) return;

		process.stdout.write(ENABLE_MOUSE);

		// Desligar é obrigatório: um terminal deixado em modo de rastreamento
		// continua cuspindo sequências de escape a cada clique, mesmo depois que
		// o programa morreu.
		const disable = () => process.stdout.write(DISABLE_MOUSE);
		process.once("exit", disable);

		return () => {
			process.off("exit", disable);
			disable();
		};
	}, [enabled]);

	/**
	 * Os eventos chegam pelo `useInput` do próprio ink, NÃO por um listener
	 * próprio em `process.stdin`.
	 *
	 * O ink 7 lê o stdin em modo `readable` (pull). Registrar um `on("data")`
	 * coloca o stream em modo flowing e disputa os bytes com ele — na prática o
	 * listener não recebia nada e ainda arriscava engolir teclas do ink. Como o
	 * ink entrega a sequência de mouse inteira como se fosse "texto digitado"
	 * (verificado: `[<0;10;5M`), basta interpretá-la aqui.
	 */
	useInput(
		(input) => {
			if (!isMouseInput(input)) return;
			for (const event of parseMouse(input).events)
				dispatch(regions.current, event);
		},
		{ isActive: enabled },
	);

	const value = useMemo(
		() => ({ enabled, toggle: () => setEnabled((e) => !e), register }),
		[enabled, register],
	);

	return (
		<MouseContext.Provider value={value}>{children}</MouseContext.Provider>
	);
}

export function useMouse(): MouseContextValue {
	const ctx = useContext(MouseContext);
	if (!ctx)
		// Só acontece se alguém renderizar uma tela fora do App — vale falhar
		// alto em vez de silenciosamente ignorar cliques.
		throw new Error("useMouse precisa estar dentro de <MouseProvider>");
	return ctx;
}

/**
 * Marca um Box como clicável. O `ref` devolvido vai no Box que delimita a área.
 *
 * `enabled` existe pelo mesmo motivo que o `isActive` do teclado: com overlay
 * aberto, a lista de baixo CONTINUA montada (é o que preserva o cursor) e
 * continuava registrada aqui. Como o hit-testing escolhe a menor área que
 * contém o ponto, sem z-order, um clique fora da caixa centralizada caía na
 * lista e empilhava um segundo `detail` por cima de um formulário aberto. O
 * teclado tinha um dono por camada; o mouse tinha vários.
 */
export function useClickable(handlers: {
	onClick?: (info: ClickInfo) => void;
	onWheel?: (direction: -1 | 1, info: ClickInfo) => void;
	/** default true — false quando a camada não é a do topo */
	enabled?: boolean;
}): RefObject<DOMElement | null> {
	const ref = useRef<DOMElement | null>(null);
	const { register } = useMouse();
	// Handlers em ref: registrar de novo a cada render (as funções mudam de
	// identidade) faria o registro piscar entre eventos.
	const latest = useRef(handlers);
	latest.current = handlers;

	useEffect(
		() =>
			register({
				id: -1,
				ref,
				// A checagem é no DISPARO (via ref), não no registro: assim ligar e
				// desligar a camada não precisa re-registrar a região a cada render.
				onClick: (info) => {
					if (latest.current.enabled === false) return;
					latest.current.onClick?.(info);
				},
				onWheel: (dir, info) => {
					if (latest.current.enabled === false) return;
					latest.current.onWheel?.(dir, info);
				},
			}),
		[register],
	);

	return ref;
}

// ------------------------------------------------------------- hit testing

type Rect = { x: number; y: number; width: number; height: number };

export function dispatch(
	regions: Map<number, Region>,
	event: TerminalMouseEvent,
): void {
	// SHIFT = "o mouse é do terminal agora". A maioria dos terminais (Windows
	// Terminal, GNOME Terminal, xterm, Kitty; no iTerm2 é Option) já intercepta
	// o gesto ANTES da aplicação e nem nos manda o evento — nesses, selecionar
	// texto com shift+arrastar sempre funcionou. Nos que NÃO interceptam, o
	// press chegava até aqui e disparava a ação do item sob o cursor: o usuário
	// tentava marcar um trecho e abria um menu. Ignorar o evento aqui cobre
	// exatamente esses casos, sem tirar nada de quem já tem o override nativo.
	if (event.shift) return;

	// Só o pressionar interessa: tratar press E release dispararia a ação duas
	// vezes por clique.
	if (event.kind === "release") return;

	let best: { region: Region; rect: Rect } | null = null;

	for (const region of regions.values()) {
		const rect = absoluteRect(region.ref.current);
		if (!rect || !contains(rect, event.x, event.y)) continue;
		// menor área vence: o item dentro do painel, não o painel
		if (!best || area(rect) < area(best.rect)) best = { region, rect };
	}

	if (!best) return;

	const info: ClickInfo = {
		row: event.y - best.rect.y,
		column: event.x - best.rect.x,
		event,
	};

	if (event.kind === "wheel-up") best.region.onWheel?.(-1, info);
	else if (event.kind === "wheel-down") best.region.onWheel?.(1, info);
	else best.region.onClick?.(info);
}

/**
 * Posição absoluta de um nó: soma os offsets computados subindo pela árvore.
 * O yoga só sabe a posição RELATIVA ao pai.
 */
function absoluteRect(node: DOMElement | null): Rect | null {
	const yoga = node?.yogaNode;
	if (!node || !yoga) return null;

	// O tipo público do ink não expõe a cadeia de pais com o yogaNode, mas ela
	// existe em runtime — é assim que o próprio ink calcula o desenho.
	type Walkable = { yogaNode?: typeof yoga; parentNode?: Walkable | null };

	let x = 0;
	let y = 0;
	let current: Walkable | null | undefined = node as unknown as Walkable;

	while (current?.yogaNode) {
		x += current.yogaNode.getComputedLeft();
		y += current.yogaNode.getComputedTop();
		current = current.parentNode;
	}

	return {
		x,
		y,
		width: yoga.getComputedWidth(),
		height: yoga.getComputedHeight(),
	};
}

function contains(rect: Rect, x: number, y: number): boolean {
	return (
		x >= rect.x &&
		x < rect.x + rect.width &&
		y >= rect.y &&
		y < rect.y + rect.height
	);
}

function area(rect: Rect): number {
	return rect.width * rect.height;
}
