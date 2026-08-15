# Painel de serviços da TUI — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir as telas `Home`/`Services`/`Running` da TUI por um painel único de gerenciamento de serviços com overlays, estado persistido em `~/.pulsar` e sudo resolvido durante a criação.

**Architecture:** Núcleo puro em `src/core/` (nada importa React) + casca Ink em `src/tui/`. A tela raiz é uma lista de serviços em largura cheia; detalhe, formulário, logs e ajuda são overlays `position="absolute"` por cima dela. O estado de cada serviço vive em `~/.pulsar/services/<nome>.json` e é cruzado em tempo de render com `discoverServices()`.

**Tech Stack:** Bun, TypeScript, Ink 7 (React 19), Zod, Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-15-tui-service-panel-design.md`

## Global Constraints

- **Nada em `src/core/` importa React.** Nada em `src/tui/` fala com o driver do Mongo nem com o SO diretamente. É a regra que mantém `bun test` rodando sem TTY e sem supervisor.
- **Idioma:** identificadores e tipos em inglês; comentários, textos de tela e mensagens de commit em português. É o padrão de todo o `src/tui/` e `src/core/service/` existentes.
- **Comentário explica POR QUÊ, não o quê.** O projeto usa comentários de bloco densos no topo de cada módulo, contando qual bug motivou a decisão. Siga isso.
- **Toda escrita de arquivo de estado é atômica** (tmp + `renameSync`), como `src/core/config/writeConfig.ts` já faz.
- **Nenhum comando com `sudo` roda sem o usuário ver o comando literal antes.**
- **Formatação:** `bunx biome check --write src test` antes de cada commit.
- **Testes:** `bun test` deve passar inteiro ao fim de cada task. Testes que precisam de Mongo (`test/engine.*`, `test/sync*`) exigem `bun run test:up`; os testes deste plano não precisam de nenhum container.
- **Prefixo de serviço:** `pulsar-<slug>` para systemd/pm2/docker, `com.pulsar.<slug>` para launchd — já implementado em `src/core/service/types.ts`, não reinventar.
- **Autoria dos commits:** o repositório não tem `user.name`/`user.email` configurados. Confirme com `git config user.email` antes do primeiro commit e configure se necessário; commits anteriores usam `blpsoares <bryanluccas@hotmail.com>`.

---

## Estrutura de arquivos

**Criar:**

| Arquivo | Responsabilidade |
|---|---|
| `src/core/state/registry.ts` | Ler/gravar `~/.pulsar/services/*.json`; schema Zod; escrita atômica |
| `src/core/state/runRecord.ts` | Gravar `lastRun` ao fim de um comando; formatar stats por modo |
| `src/core/state/adopt.ts` | Reconstruir registro a partir do supervisor (ExecStart/command/ecosystem) |
| `src/core/state/reconcile.ts` | Cruzar registro × `discoverServices()`; produzir a lista da tela |
| `src/core/service/privileged.ts` | Decidir entre rodar direto / pedir senha / pular passo com sudo |
| `src/core/service/oneshot.ts` | Desligar o boot quando um one-shot conclui com sucesso |
| `src/core/service/switchBackend.ts` | Trocar backend com rollback para o anterior |
| `src/core/tty/handoff.ts` | Entregar e retomar o TTY (alternate screen, mouse, raw mode) |
| `src/tui/keys.ts` | Registro declarativo de teclas por camada; fonte da barra e do `?` |
| `src/tui/components/Overlay.tsx` | Caixa flutuante centralizada sobre a tela raiz |
| `src/tui/components/HelpOverlay.tsx` | Ajuda contextual (`?`) montada a partir de `keys.ts` |
| `src/tui/screens/ServicesPanel.tsx` | Tela raiz: lista de serviços |
| `src/tui/screens/ServiceDetail.tsx` | Overlay de detalhe + ações |
| `src/tui/screens/ServiceForm.tsx` | Overlay de criação/edição |
| `src/tui/screens/LogViewer.tsx` | Log em tela cheia com rolagem, busca e cópia |
| `test/state.test.ts` | registry, runRecord, adopt, reconcile |
| `test/privileged.test.ts` | privileged, oneshot, switchBackend |
| `test/tuiKeys.test.ts` | teclas anunciadas × teclas tratadas; geometria do overlay |

**Modificar:**

| Arquivo | Mudança |
|---|---|
| `src/tui/layout.ts` | Adicionar `overlay(columns, rows)` |
| `src/tui/components/Shell.tsx` | Prop `overlay`; `hints` derivado de `keys.ts` |
| `src/tui/App.tsx` | Reduzir a rota única + camadas de overlay |
| `src/core/service/manager.ts:177` | Remover `if (step.privileged) continue;` |
| `src/commands/sync.ts`, `migrate.ts`, `ttl.ts` | Chamar `runRecord` ao terminar |
| `CLAUDE.md` | Reescrever a seção "TUI" |
| `docs/superpowers/specs/2026-08-15-tui-service-panel-design.md` | Status → implementado |

**Remover** (na Task 15, depois que o substituto estiver de pé): `src/tui/screens/Home.tsx`, `src/tui/screens/Services.tsx`, `src/tui/screens/Running.tsx`, `src/tui/hooks/useBackgroundStart.ts`, `src/tui/screens/Wizard.tsx`.

**Ordem:** as Tasks 1 e 2 vêm primeiro porque são os dois riscos da spec. Se o overlay absoluto não funcionar no Ink 7, o desenho inteiro muda — descobrir isso na Task 11 seria caro.

---

### Task 1: Overlay flutuante (o risco nº 2 da spec)

Prova concreta de que `position="absolute"` compõe por cima no Ink 7, mais a geometria pura que todos os overlays vão usar.

**Files:**
- Create: `src/tui/components/Overlay.tsx`
- Modify: `src/tui/layout.ts`
- Test: `test/tuiKeys.test.ts`

**Interfaces:**
- Consumes: `theme` de `src/tui/theme.ts`
- Produces:
  - `overlayBox(columns: number, rows: number): { width: number; height: number; marginLeft: number; marginTop: number }`
  - `<Overlay title={string} columns={number} rows={number} footer?={ReactNode}>{children}</Overlay>`

- [ ] **Step 1: Escrever o teste da geometria**

Em `test/tuiKeys.test.ts` (arquivo novo):

```ts
import { describe, expect, test } from "bun:test";
import { overlayBox } from "../src/tui/layout";

describe("overlayBox", () => {
	test("centraliza a caixa com margem no terminal largo", () => {
		const box = overlayBox(120, 40);
		expect(box.width).toBeLessThan(120);
		expect(box.marginLeft).toBe(Math.floor((120 - box.width) / 2));
		expect(box.marginTop).toBeGreaterThan(0);
	});

	test("abaixo de 60 colunas usa a largura toda", () => {
		// Caixa centralizada num terminal estreito sobra 4 colunas de conteúdo:
		// pior que não ter moldura nenhuma.
		const box = overlayBox(50, 20);
		expect(box.width).toBe(50);
		expect(box.marginLeft).toBe(0);
	});

	test("nunca passa da tela", () => {
		for (const [cols, rows] of [[40, 10], [80, 24], [200, 60]] as const) {
			const box = overlayBox(cols, rows);
			expect(box.width + box.marginLeft).toBeLessThanOrEqual(cols);
			expect(box.height + box.marginTop).toBeLessThanOrEqual(rows);
		}
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/tuiKeys.test.ts`
Expected: FAIL — `overlayBox` não é exportado de `layout.ts`.

- [ ] **Step 3: Implementar `overlayBox`**

Acrescentar ao fim de `src/tui/layout.ts`:

```ts
/** Abaixo disto, moldura centralizada deixaria conteúdo ilegível. */
const OVERLAY_MIN_COLUMNS = 60;
/** Fração da tela que o overlay ocupa quando há espaço de sobra. */
const OVERLAY_RATIO = 0.8;

export type OverlayBox = {
	width: number;
	height: number;
	marginLeft: number;
	marginTop: number;
};

/**
 * Geometria da caixa flutuante.
 *
 * Separada do componente pela mesma razão que `layout()`: é a conta que decide
 * se o formulário respira ou não, e testá-la exige zero React.
 */
export function overlayBox(columns: number, rows: number): OverlayBox {
	const full = columns < OVERLAY_MIN_COLUMNS;
	const width = full ? columns : Math.round(columns * OVERLAY_RATIO);
	const height = Math.max(6, Math.min(rows, Math.round(rows * OVERLAY_RATIO)));

	return {
		width,
		height,
		marginLeft: Math.floor((columns - width) / 2),
		marginTop: Math.floor((rows - height) / 2),
	};
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test test/tuiKeys.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Implementar o componente**

Criar `src/tui/components/Overlay.tsx`:

```tsx
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { overlayBox } from "../layout";
import { theme } from "../theme";

/**
 * Caixa flutuante desenhada POR CIMA da tela raiz.
 *
 * `position="absolute"` tira a caixa do fluxo do Yoga, então a lista de baixo
 * não é empurrada — ela continua desenhada e o overlay sobrescreve as células
 * que ocupa. É o que dá a sensação de camada, e é por isso que `esc` devolve o
 * cursor exatamente onde estava: a lista nunca desmontou.
 */
export function Overlay({
	title,
	columns,
	rows,
	footer,
	children,
}: {
	title: string;
	columns: number;
	rows: number;
	footer?: ReactNode;
	children: ReactNode;
}) {
	const box = overlayBox(columns, rows);

	return (
		<Box
			position="absolute"
			marginLeft={box.marginLeft}
			marginTop={box.marginTop}
			width={box.width}
			height={box.height}
			flexDirection="column"
		>
			<Text color={theme.accent}>
				╭─<Text bold>{` ${title} `}</Text>
				{"─".repeat(Math.max(0, box.width - title.length - 5))}╮
			</Text>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderTop={false}
				borderColor={theme.accent}
				paddingX={1}
				flexGrow={1}
			>
				<Box flexDirection="column" flexGrow={1}>
					{children}
				</Box>
				{footer ? <Box marginTop={1}>{footer}</Box> : null}
			</Box>
		</Box>
	);
}
```

- [ ] **Step 6: Provar no terminal que compõe por cima**

Criar um arquivo descartável `scratch-overlay.tsx` na raiz:

```tsx
import { Box, render, Text } from "ink";
import { Overlay } from "./src/tui/components/Overlay";

render(
	<Box flexDirection="column" width={100} height={30}>
		{Array.from({ length: 30 }, (_, i) => (
			<Text key={i}>{`linha de fundo ${i} `.repeat(6)}</Text>
		))}
		<Overlay title="prova" columns={100} rows={30}>
			<Text>se você lê isto com o fundo visível em volta, funciona</Text>
		</Overlay>
	</Box>,
);
```

Run: `tmux new-session -d -s ov -x 100 -y 30 "bun scratch-overlay.tsx" && sleep 2 && tmux capture-pane -p -t ov && tmux kill-session -t ov`

Expected: a caixa "prova" aparece centralizada, com as linhas de fundo visíveis ao redor e **sem** as linhas de fundo terem sido empurradas para baixo.

**Se não compuser por cima:** pare e reporte. O plano de contingência é o overlay virar um `Box` que substitui o corpo do `Shell` mantendo header e barra de teclas — mesma API do componente, mesma preservação de estado, só sem o fundo visível. Nenhuma outra task muda.

- [ ] **Step 7: Apagar o scratch e commitar**

```bash
rm scratch-overlay.tsx
bunx biome check --write src test
git add src/tui/layout.ts src/tui/components/Overlay.tsx test/tuiKeys.test.ts
git commit -m "feat(tui): caixa de overlay flutuante e sua geometria"
```

---

### Task 2: Entrega do TTY para o sudo (o risco nº 1 da spec)

**Files:**
- Create: `src/core/tty/handoff.ts`
- Test: `test/privileged.test.ts`

**Interfaces:**
- Consumes: `ENABLE_MOUSE`, `DISABLE_MOUSE` de `src/tui/mouse/parse.ts` — **atenção**: esses literais precisam sair de `src/tui/` para `src/core/tty/ansi.ts` nesta task, porque `core` não pode importar de `tui`.
- Produces:
  - `withTerminal<T>(fn: () => Promise<T>, io?: TerminalIo): Promise<T>`
  - `type TerminalIo = { stdout: { write(s: string): void }; stdin: { isTTY?: boolean; setRawMode?(v: boolean): void } }`
  - `ENTER_ALT`, `LEAVE_ALT`, `ENABLE_MOUSE`, `DISABLE_MOUSE` em `src/core/tty/ansi.ts`

- [ ] **Step 1: Escrever o teste**

Criar `test/privileged.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { LEAVE_ALT, ENTER_ALT, DISABLE_MOUSE } from "../src/core/tty/ansi";
import { withTerminal } from "../src/core/tty/handoff";

function fakeIo() {
	const written: string[] = [];
	const raw: boolean[] = [];
	return {
		written,
		raw,
		io: {
			stdout: { write: (s: string) => void written.push(s) },
			stdin: { isTTY: true, setRawMode: (v: boolean) => void raw.push(v) },
		},
	};
}

describe("withTerminal", () => {
	test("solta e retoma o terminal em volta da função", async () => {
		const { written, raw, io } = fakeIo();
		await withTerminal(async () => "ok", io);

		const all = written.join("");
		expect(all).toContain(LEAVE_ALT);
		expect(all).toContain(DISABLE_MOUSE);
		expect(all).toContain(ENTER_ALT);
		// solta o raw mode e devolve
		expect(raw).toEqual([false, true]);
	});

	test("restaura MESMO quando a função joga", async () => {
		// É o teste que importa: falhar aqui deixa o terminal do usuário sem eco.
		const { written, raw, io } = fakeIo();
		await expect(
			withTerminal(async () => {
				throw new Error("sudo falhou");
			}, io),
		).rejects.toThrow("sudo falhou");

		expect(written.join("")).toContain(ENTER_ALT);
		expect(raw).toEqual([false, true]);
	});

	test("devolve o valor da função", async () => {
		const { io } = fakeIo();
		expect(await withTerminal(async () => 42, io)).toBe(42);
	});

	test("sem TTY não tenta mexer em raw mode", async () => {
		const written: string[] = [];
		await withTerminal(async () => null, {
			stdout: { write: (s: string) => void written.push(s) },
			stdin: { isTTY: false },
		});
		expect(written.join("")).toBe("");
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/privileged.test.ts`
Expected: FAIL — módulos não existem.

- [ ] **Step 3: Criar `src/core/tty/ansi.ts`**

```ts
/**
 * Sequências ANSI de controle de terminal.
 *
 * Ficam em `core` (e não em `tui/mouse/parse.ts`, onde as de mouse nasceram)
 * porque quem precisa soltar o terminal é a camada de serviço, e `core` não
 * pode importar de `tui`. O `parse.ts` passa a reexportar daqui para não haver
 * duas verdades sobre a mesma sequência.
 */

export const ENTER_ALT = "\x1b[?1049h";
export const LEAVE_ALT = "\x1b[?1049l";
export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";
```

Em `src/tui/mouse/parse.ts`, trocar as duas constantes por reexportação:

```ts
export { DISABLE_MOUSE, ENABLE_MOUSE } from "../../core/tty/ansi";
```

- [ ] **Step 4: Criar `src/core/tty/handoff.ts`**

```ts
import { DISABLE_MOUSE, ENABLE_MOUSE, ENTER_ALT, LEAVE_ALT } from "./ansi";

/**
 * Empresta o terminal para um comando interativo (hoje: o `sudo` pedindo senha)
 * e o devolve à TUI depois.
 *
 * A restauração está em `finally` e isso NÃO é estilo: se o processo sair daqui
 * sem reentrar no alternate screen e sem religar o raw mode, o usuário fica com
 * um terminal sem eco, digitando às cegas, e a única saída é `reset`. Qualquer
 * caminho de erro tem que passar pela restauração.
 */

export type TerminalIo = {
	stdout: { write(s: string): void };
	stdin: { isTTY?: boolean; setRawMode?(v: boolean): void };
};

export async function withTerminal<T>(
	fn: () => Promise<T>,
	io: TerminalIo = process as unknown as TerminalIo,
): Promise<T> {
	// Sem TTY (teste, container, pipe) não há nada para soltar nem restaurar.
	if (!io.stdin.isTTY) return fn();

	io.stdin.setRawMode?.(false);
	io.stdout.write(DISABLE_MOUSE);
	io.stdout.write(LEAVE_ALT);

	try {
		return await fn();
	} finally {
		io.stdout.write(ENTER_ALT);
		io.stdout.write(ENABLE_MOUSE);
		io.stdin.setRawMode?.(true);
	}
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test test/privileged.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 6: Verificação manual — o teste que a máquina não faz**

Criar `scratch-tty.ts`:

```ts
import { spawn } from "node:child_process";
import { withTerminal } from "./src/core/tty/handoff";

await withTerminal(
	() =>
		new Promise<void>((resolve) => {
			const child = spawn("sudo", ["-k", "true"], { stdio: "inherit" });
			child.on("close", () => resolve());
		}),
);
console.log("de volta — digite algo e confirme que o eco funciona:");
process.stdin.once("data", (d) => {
	console.log("recebi:", String(d).trim());
	process.exit(0);
});
```

Run: `bun scratch-tty.ts` (num terminal de verdade, não pelo tmux capture)
Expected: o sudo pede a senha normalmente; depois de responder, o texto que você digitar **aparece na tela**. Se não aparecer, a restauração está errada — pare aqui.

- [ ] **Step 7: Apagar o scratch e commitar**

```bash
rm scratch-tty.ts
bunx biome check --write src test
git add src/core/tty test/privileged.test.ts src/tui/mouse/parse.ts
git commit -m "feat(core): empresta o terminal a um comando interativo e o devolve"
```

---

### Task 3: Registro do serviço em `~/.pulsar`

**Files:**
- Create: `src/core/state/registry.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `Backend` de `src/core/service/types.ts`, `RunMode` de `src/core/run/pulsarCommand.ts`
- Produces:
  - `type RunStats = Record<string, number>`
  - `type LastRun = { startedAt: string; endedAt: string | null; status: "ok" | "error" | "running"; exitCode: number | null; stats: RunStats; error: string | null }`
  - `type ServiceRecord = { name: string; mode: RunMode; config: string; workingDir: string; backend: Backend; boot: boolean; createdBy: string; lastRun: LastRun | null }`
  - `registryDir(home?: string): string`
  - `readRecord(name: string, home?: string): ServiceRecord | null`
  - `writeRecord(record: ServiceRecord, home?: string): void`
  - `listRecords(home?: string): ServiceRecord[]`
  - `removeRecord(name: string, home?: string): void`
  - `CREATED_BY_TUI = "pulsar-tui"`

O parâmetro `home` existe só para os testes apontarem para um diretório temporário; a produção sempre omite.

- [ ] **Step 1: Escrever os testes**

Criar `test/state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CREATED_BY_TUI,
	listRecords,
	readRecord,
	registryDir,
	removeRecord,
	type ServiceRecord,
	writeRecord,
} from "../src/core/state/registry";

function home() {
	return mkdtempSync(join(tmpdir(), "pulsar-home-"));
}

const base: ServiceRecord = {
	name: "pulsar-ads",
	mode: "sync",
	config: "/srv/pulsar/ads.yml",
	workingDir: "/srv/pulsar",
	backend: "systemd",
	boot: true,
	createdBy: CREATED_BY_TUI,
	lastRun: null,
};

describe("registry", () => {
	test("grava e lê de volta", () => {
		const h = home();
		writeRecord(base, h);
		expect(readRecord("pulsar-ads", h)).toEqual(base);
	});

	test("serviço inexistente devolve null, não joga", () => {
		expect(readRecord("pulsar-nao-existe", home())).toBeNull();
	});

	test("lista todos, em ordem de nome", () => {
		const h = home();
		writeRecord({ ...base, name: "pulsar-z" }, h);
		writeRecord({ ...base, name: "pulsar-a" }, h);
		expect(listRecords(h).map((r) => r.name)).toEqual(["pulsar-a", "pulsar-z"]);
	});

	test("json corrompido é ignorado sem derrubar a lista", () => {
		// A lista da tela não pode sumir por causa de um arquivo estragado.
		const h = home();
		writeRecord(base, h);
		mkdirSync(registryDir(h), { recursive: true });
		writeFileSync(join(registryDir(h), "quebrado.json"), "{ isto não é json");
		expect(listRecords(h).map((r) => r.name)).toEqual(["pulsar-ads"]);
	});

	test("json válido mas fora do schema é ignorado", () => {
		const h = home();
		mkdirSync(registryDir(h), { recursive: true });
		writeFileSync(join(registryDir(h), "x.json"), JSON.stringify({ nome: 1 }));
		expect(listRecords(h)).toEqual([]);
	});

	test("remover apaga o arquivo", () => {
		const h = home();
		writeRecord(base, h);
		removeRecord("pulsar-ads", h);
		expect(readRecord("pulsar-ads", h)).toBeNull();
	});

	test("não deixa arquivo temporário para trás", () => {
		const h = home();
		writeRecord(base, h);
		const { readdirSync } = require("node:fs");
		expect(readdirSync(registryDir(h))).toEqual(["pulsar-ads.json"]);
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/state.test.ts`
Expected: FAIL — `registry` não existe.

- [ ] **Step 3: Implementar**

Criar `src/core/state/registry.ts`:

```ts
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RunMode } from "../run/pulsarCommand";
import type { Backend } from "../service/types";

/**
 * O que o pulsar sabe sobre um serviço além do que o supervisor conta.
 *
 * `discoverServices()` responde "existe e está no ar"; não responde "é um
 * migrate, aponta para este yml, e da última vez copiou 1.2M documentos". Esse
 * segundo conjunto não cabe em nenhum supervisor, e precisa sobreviver à TUI
 * fechada: o serviço roda no boot às 3h da manhã e o resultado tem que estar
 * aqui quando alguém abrir a tela.
 *
 * Um arquivo por serviço (e não um índice único) porque dois processos podem
 * terminar ao mesmo tempo — com arquivo por serviço, cada um escreve o seu e
 * não há disputa por um índice compartilhado.
 */

export const CREATED_BY_TUI = "pulsar-tui";

const lastRunSchema = z.object({
	startedAt: z.string(),
	endedAt: z.string().nullable(),
	status: z.enum(["ok", "error", "running"]),
	exitCode: z.number().nullable(),
	stats: z.record(z.string(), z.number()),
	error: z.string().nullable(),
});

const recordSchema = z.object({
	name: z.string().min(1),
	mode: z.enum(["sync", "migrate", "ttl"]),
	config: z.string().min(1),
	workingDir: z.string().min(1),
	backend: z.enum(["systemd", "launchd", "pm2", "docker"]),
	boot: z.boolean(),
	createdBy: z.string(),
	lastRun: lastRunSchema.nullable(),
});

export type LastRun = z.infer<typeof lastRunSchema>;
export type RunStats = LastRun["stats"];
export type ServiceRecord = z.infer<typeof recordSchema> & {
	mode: RunMode;
	backend: Backend;
};

export function registryDir(home: string = homedir()): string {
	return join(home, ".pulsar", "services");
}

function recordPath(name: string, home?: string): string {
	return join(registryDir(home), `${name}.json`);
}

export function readRecord(name: string, home?: string): ServiceRecord | null {
	return parseFile(recordPath(name, home));
}

export function writeRecord(record: ServiceRecord, home?: string): void {
	const dir = registryDir(home);
	mkdirSync(dir, { recursive: true });

	// tmp + rename: um Ctrl+C no meio da escrita não deixa um registro pela
	// metade no lugar de um que funcionava. Mesmo padrão do writeConfig.
	const target = recordPath(record.name, home);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
	renameSync(tmp, target);
}

export function listRecords(home?: string): ServiceRecord[] {
	const dir = registryDir(home);
	if (!existsSync(dir)) return [];

	const out: ServiceRecord[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const record = parseFile(join(dir, file));
		if (record) out.push(record);
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function removeRecord(name: string, home?: string): void {
	rmSync(recordPath(name, home), { force: true });
}

/**
 * Registro ilegível (json quebrado, schema antigo, arquivo truncado) devolve
 * `null` em vez de jogar: a lista de serviços inteira não pode sumir por causa
 * de um arquivo estragado. Quem some é o significado daquele serviço, e ele
 * reaparece como "adotado".
 */
function parseFile(path: string): ServiceRecord | null {
	try {
		const parsed = recordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
		return parsed.success ? (parsed.data as ServiceRecord) : null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test test/state.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 5: Commitar**

```bash
bunx biome check --write src test
git add src/core/state/registry.ts test/state.test.ts
git commit -m "feat(core): registro de serviços em ~/.pulsar"
```

---

### Task 4: Gravar o resultado da execução (`runRecord`)

**Files:**
- Create: `src/core/state/runRecord.ts`
- Modify: `src/commands/sync.ts`, `src/commands/migrate.ts`, `src/commands/ttl.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `readRecord`, `writeRecord`, `RunStats`, `ServiceRecord` da Task 3
- Produces:
  - `beginRun(name: string, home?: string): void`
  - `finishRun(name: string, outcome: { status: "ok" | "error"; exitCode: number | null; stats: RunStats; error?: string | null }, home?: string): void`
  - `serviceNameFromEnv(): string | null`

O processo descobre **qual** serviço ele é pela variável de ambiente `PULSAR_SERVICE_NAME`, que os quatro backends já podem injetar (a unit systemd tem `Environment=`, o compose tem `environment:`, o ecosystem tem `env`). Rodando à mão, a variável não existe e `runRecord` não faz nada — é o comportamento certo: execução avulsa não é um serviço.

- [ ] **Step 1: Escrever os testes**

Acrescentar a `test/state.test.ts`:

```ts
import { beginRun, finishRun, serviceNameFromEnv } from "../src/core/state/runRecord";

describe("runRecord", () => {
	test("beginRun marca running e limpa o resultado anterior", () => {
		const h = home();
		writeRecord(base, h);
		beginRun("pulsar-ads", h);

		const run = readRecord("pulsar-ads", h)?.lastRun;
		expect(run?.status).toBe("running");
		expect(run?.endedAt).toBeNull();
		expect(run?.startedAt).toBeTruthy();
	});

	test("finishRun grava stats e mantém o startedAt do begin", () => {
		const h = home();
		writeRecord(base, h);
		beginRun("pulsar-ads", h);
		const startedAt = readRecord("pulsar-ads", h)?.lastRun?.startedAt;

		finishRun("pulsar-ads", {
			status: "ok",
			exitCode: 0,
			stats: { collections: 49, inserted: 1214882 },
		}, h);

		const run = readRecord("pulsar-ads", h)?.lastRun;
		expect(run?.status).toBe("ok");
		expect(run?.startedAt).toBe(startedAt as string);
		expect(run?.endedAt).toBeTruthy();
		expect(run?.stats.inserted).toBe(1214882);
		expect(run?.error).toBeNull();
	});

	test("finishRun com erro guarda a mensagem", () => {
		const h = home();
		writeRecord(base, h);
		finishRun("pulsar-ads", {
			status: "error",
			exitCode: 1,
			stats: {},
			error: "ECONNREFUSED 127.0.0.1:27017",
		}, h);

		const run = readRecord("pulsar-ads", h)?.lastRun;
		expect(run?.status).toBe("error");
		expect(run?.error).toContain("ECONNREFUSED");
	});

	test("serviço sem registro não cria registro nenhum", () => {
		// Rodar `pulsar sync x.yml` à mão não é um serviço e não deve inventar um.
		const h = home();
		finishRun("pulsar-avulso", { status: "ok", exitCode: 0, stats: {} }, h);
		expect(readRecord("pulsar-avulso", h)).toBeNull();
	});

	test("serviceNameFromEnv lê a variável e devolve null sem ela", () => {
		process.env.PULSAR_SERVICE_NAME = "pulsar-x";
		expect(serviceNameFromEnv()).toBe("pulsar-x");
		delete process.env.PULSAR_SERVICE_NAME;
		expect(serviceNameFromEnv()).toBeNull();
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/state.test.ts`
Expected: FAIL — `runRecord` não existe.

- [ ] **Step 3: Implementar**

Criar `src/core/state/runRecord.ts`:

```ts
import { readRecord, type RunStats, writeRecord } from "./registry";

/**
 * O resultado da última execução, gravado pelo PRÓPRIO processo do pulsar.
 *
 * Não dá para a TUI observar isso de fora: o serviço roda no boot, sem
 * ninguém olhando, e termina horas depois. Quem sabe quantos documentos foram
 * copiados é quem os copiou — os números já existem (são os mesmos do painel
 * final), só estavam virando texto e se perdendo.
 *
 * Execução avulsa (`pulsar sync x.yml` no terminal) não tem
 * `PULSAR_SERVICE_NAME` e não grava nada: não é um serviço e não deve inventar
 * um registro.
 */

export function serviceNameFromEnv(): string | null {
	return process.env.PULSAR_SERVICE_NAME || null;
}

export function beginRun(name: string, home?: string): void {
	const record = readRecord(name, home);
	if (!record) return;

	writeRecord(
		{
			...record,
			lastRun: {
				startedAt: new Date().toISOString(),
				endedAt: null,
				status: "running",
				exitCode: null,
				stats: {},
				error: null,
			},
		},
		home,
	);
}

export function finishRun(
	name: string,
	outcome: {
		status: "ok" | "error";
		exitCode: number | null;
		stats: RunStats;
		error?: string | null;
	},
	home?: string,
): void {
	const record = readRecord(name, home);
	if (!record) return;

	writeRecord(
		{
			...record,
			lastRun: {
				// Preserva o início marcado pelo beginRun; sem ele, a duração seria 0.
				startedAt: record.lastRun?.startedAt ?? new Date().toISOString(),
				endedAt: new Date().toISOString(),
				status: outcome.status,
				exitCode: outcome.exitCode,
				stats: outcome.stats,
				error: outcome.error ?? null,
			},
		},
		home,
	);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test test/state.test.ts`
Expected: PASS (12 testes no total do arquivo).

- [ ] **Step 5: Ligar nos três comandos**

Em `src/commands/sync.ts`, logo após a config ser carregada e antes de conectar:

```ts
import { beginRun, finishRun, serviceNameFromEnv } from "../core/state/runRecord";

const serviceName = serviceNameFromEnv();
if (serviceName) beginRun(serviceName);
```

No `shutdown()` do mesmo arquivo, **antes** do `process.exit()` e depois do flush dos checkpoints:

```ts
if (serviceName)
	finishRun(serviceName, {
		status: "ok",
		exitCode: 0,
		stats: {
			collections: stats.total,
			resumed: stats.resumed,
			dumped: stats.dumped,
			docs: stats.docsCopied,
			indexes: stats.indexesCreated,
			views: stats.viewsCreated,
		},
	});
```

Use os nomes de campo que o painel final de `sync.ts` já calcula — leia o bloco que monta `PULSAR · INITIAL SYNC COMPLETE` e reaproveite as mesmas variáveis. Se um número não existir como variável (só como texto formatado), extraia-o para uma variável antes.

No `catch` do erro fatal:

```ts
if (serviceName)
	finishRun(serviceName, {
		status: "error",
		exitCode: 1,
		stats: {},
		error: err instanceof Error ? err.message : String(err),
	});
```

Repita o mesmo padrão em `src/commands/migrate.ts` (stats: `collections`, `docs`) e `src/commands/ttl.ts` (stats: `collections`, `indexes`, `materialized`).

- [ ] **Step 6: Verificar de ponta a ponta**

```bash
mkdir -p ~/.pulsar/services
cat > ~/.pulsar/services/pulsar-teste-plano.json <<'JSON'
{"name":"pulsar-teste-plano","mode":"ttl","config":"/tmp/x.yml","workingDir":"/tmp","backend":"systemd","boot":false,"createdBy":"pulsar-tui","lastRun":null}
JSON
PULSAR_SERVICE_NAME=pulsar-teste-plano bun run src/cli.ts ttl configs/ttl-example.yml
cat ~/.pulsar/services/pulsar-teste-plano.json
```

Expected: o json passa a ter `lastRun` com `status` (`ok` ou `error`, dependendo de o Mongo do exemplo estar de pé) e `endedAt` preenchido. Apague o arquivo depois: `rm ~/.pulsar/services/pulsar-teste-plano.json`.

- [ ] **Step 7: Commitar**

```bash
bunx biome check --write src test
git add src/core/state/runRecord.ts test/state.test.ts src/commands
git commit -m "feat(core): comandos gravam o resultado da execução no registro"
```

---

### Task 5: Adotar serviço sem registro

**Files:**
- Create: `src/core/state/adopt.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `ServiceRecord`, `CREATED_BY_TUI` da Task 3
- Produces:
  - `parseExecStart(line: string): { mode: RunMode; config: string } | null`
  - `adoptFromSystemd(name: string, showOutput: string): ServiceRecord | null`
  - `adoptFromDocker(name: string, command: string, workingDir: string): ServiceRecord | null`

`showOutput` é a saída de `systemctl --user show <unit> --property=ExecStart --property=WorkingDirectory --property=UnitFileState`.

- [ ] **Step 1: Escrever os testes**

Acrescentar a `test/state.test.ts`:

```ts
import { adoptFromDocker, adoptFromSystemd, parseExecStart } from "../src/core/state/adopt";

describe("adopt", () => {
	test("extrai modo e yml de uma linha de comando", () => {
		expect(parseExecStart("/home/u/.local/bin/pulsar sync /srv/ads.yml")).toEqual({
			mode: "sync",
			config: "/srv/ads.yml",
		});
	});

	test("funciona no modo código-fonte (bun + script)", () => {
		expect(
			parseExecStart("/usr/bin/bun /home/u/pulsar/src/cli.ts migrate /srv/m.yml"),
		).toEqual({ mode: "migrate", config: "/srv/m.yml" });
	});

	test("ignora flags depois do yml", () => {
		expect(parseExecStart("pulsar sync /srv/ads.yml --verbose")).toEqual({
			mode: "sync",
			config: "/srv/ads.yml",
		});
	});

	test("linha sem modo conhecido devolve null", () => {
		expect(parseExecStart("/usr/bin/tail -f /var/log/x")).toBeNull();
	});

	test("adota uma unit do systemd", () => {
		const show = [
			"ExecStart={ path=/home/u/.local/bin/pulsar ; argv[]=/home/u/.local/bin/pulsar sync /srv/ads.yml ; ignore_errors=no }",
			"WorkingDirectory=/srv",
			"UnitFileState=enabled",
		].join("\n");

		expect(adoptFromSystemd("pulsar-ads", show)).toEqual({
			name: "pulsar-ads",
			mode: "sync",
			config: "/srv/ads.yml",
			workingDir: "/srv",
			backend: "systemd",
			boot: true,
			createdBy: "adotado",
			lastRun: null,
		});
	});

	test("unit sem ExecTart reconhecível não é adotada", () => {
		expect(adoptFromSystemd("pulsar-x", "WorkingDirectory=/srv")).toBeNull();
	});

	test("adota um container", () => {
		const record = adoptFromDocker("pulsar-sync-loja", "sync /app/loja.yml", "/srv");
		expect(record?.mode).toBe("sync");
		expect(record?.backend).toBe("docker");
		expect(record?.createdBy).toBe("adotado");
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/state.test.ts`
Expected: FAIL — `adopt` não existe.

- [ ] **Step 3: Implementar**

Criar `src/core/state/adopt.ts`:

```ts
import type { RunMode } from "../run/pulsarCommand";
import type { ServiceRecord } from "./registry";

/**
 * Reconstrói o registro a partir do que o supervisor já guarda.
 *
 * Serviço criado por uma versão anterior da TUI, ou à mão, não tem registro —
 * e sem isto viraria uma linha "pulsar-alguma-coisa" sem modo, sem yml e sem
 * ações úteis. Mas a informação existe: a unit do systemd guarda o ExecStart
 * inteiro, o container guarda o command, o pm2 guarda os args. Ler de lá custa
 * um comando e evita transformar serviço legítimo em lixo órfão.
 */

const MODES: RunMode[] = ["sync", "migrate", "ttl"];

/**
 * Acha o par (modo, yml) numa linha de comando, seja ela do binário compilado
 * (`pulsar sync x.yml`) ou do modo código-fonte (`bun src/cli.ts sync x.yml`).
 * Procurar pelo modo, e não por posição, é o que faz os dois casos caírem no
 * mesmo código.
 */
export function parseExecStart(
	line: string,
): { mode: RunMode; config: string } | null {
	const parts = line.trim().split(/\s+/);

	for (let i = 0; i < parts.length - 1; i++) {
		const mode = parts[i] as RunMode;
		const next = parts[i + 1];
		if (!MODES.includes(mode) || !next || next.startsWith("-")) continue;
		return { mode, config: next };
	}

	return null;
}

export function adoptFromSystemd(
	name: string,
	showOutput: string,
): ServiceRecord | null {
	const props = new Map<string, string>();
	for (const line of showOutput.split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) props.set(line.slice(0, i), line.slice(i + 1).trim());
	}

	// O ExecStart do `show` vem embrulhado: { path=… ; argv[]=… ; … }
	const raw = props.get("ExecStart") ?? "";
	const argv = /argv\[\]=([^;}]+)/.exec(raw)?.[1] ?? raw;
	const parsed = parseExecStart(argv);
	if (!parsed) return null;

	return {
		name,
		mode: parsed.mode,
		config: parsed.config,
		workingDir: props.get("WorkingDirectory") || ".",
		backend: "systemd",
		boot: props.get("UnitFileState") === "enabled",
		createdBy: "adotado",
		lastRun: null,
	};
}

export function adoptFromDocker(
	name: string,
	command: string,
	workingDir: string,
): ServiceRecord | null {
	const parsed = parseExecStart(command);
	if (!parsed) return null;

	return {
		name,
		mode: parsed.mode,
		config: parsed.config,
		workingDir,
		backend: "docker",
		// A política de restart é lida pelo discover; aqui só o que a linha diz.
		boot: false,
		createdBy: "adotado",
		lastRun: null,
	};
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test test/state.test.ts`
Expected: PASS (19 no arquivo).

- [ ] **Step 5: Commitar**

```bash
bunx biome check --write src test
git add src/core/state/adopt.ts test/state.test.ts
git commit -m "feat(core): adota serviço sem registro lendo o supervisor"
```

---

### Task 6: Reconciliação — a lista da tela

**Files:**
- Create: `src/core/state/reconcile.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `ServiceRecord` (Task 3), `DiscoveredService` de `src/core/service/discover.ts`
- Produces:
  - `type ServiceState = "running" | "stopped" | "done" | "failed" | "uninstalled" | "adopted"`
  - `type ServiceRow = { name: string; state: ServiceState; record: ServiceRecord | null; live: DiscoveredService | null }`
  - `reconcile(records: ServiceRecord[], live: DiscoveredService[]): ServiceRow[]`
  - `isOneShot(mode: RunMode): boolean`

- [ ] **Step 1: Escrever os testes**

Acrescentar a `test/state.test.ts`:

```ts
import type { DiscoveredService } from "../src/core/service/discover";
import { isOneShot, reconcile, type ServiceRow } from "../src/core/state/reconcile";

const live = (over: Partial<DiscoveredService>): DiscoveredService => ({
	backend: "systemd",
	name: "pulsar-ads",
	running: true,
	enabled: true,
	...over,
});

function stateOf(rows: ServiceRow[], name: string) {
	return rows.find((r) => r.name === name)?.state;
}

describe("reconcile", () => {
	test("registro + supervisor no ar", () => {
		const rows = reconcile([base], [live({})]);
		expect(stateOf(rows, "pulsar-ads")).toBe("running");
	});

	test("registro + supervisor parado", () => {
		const rows = reconcile([base], [live({ running: false })]);
		expect(stateOf(rows, "pulsar-ads")).toBe("stopped");
	});

	test("supervisor sem registro vira adotado", () => {
		const rows = reconcile([], [live({ name: "pulsar-orfao" })]);
		expect(stateOf(rows, "pulsar-orfao")).toBe("adopted");
		expect(rows[0]?.record).toBeNull();
	});

	test("registro sem supervisor vira não instalado", () => {
		const rows = reconcile([base], []);
		expect(stateOf(rows, "pulsar-ads")).toBe("uninstalled");
	});

	test("one-shot parado com lastRun ok é 'concluído', não 'parado'", () => {
		// A diferença que o usuário pediu: migrate que terminou não é "parado".
		const record = {
			...base,
			name: "pulsar-migra",
			mode: "migrate" as const,
			lastRun: {
				startedAt: "2026-08-15T10:00:00Z",
				endedAt: "2026-08-15T10:45:00Z",
				status: "ok" as const,
				exitCode: 0,
				stats: { docs: 10 },
				error: null,
			},
		};
		const rows = reconcile([record], [live({ name: "pulsar-migra", running: false })]);
		expect(stateOf(rows, "pulsar-migra")).toBe("done");
	});

	test("one-shot parado com lastRun de erro é 'falhou'", () => {
		const record = {
			...base,
			name: "pulsar-migra",
			mode: "migrate" as const,
			lastRun: {
				startedAt: "2026-08-15T10:00:00Z",
				endedAt: "2026-08-15T10:05:00Z",
				status: "error" as const,
				exitCode: 1,
				stats: {},
				error: "ECONNREFUSED",
			},
		};
		const rows = reconcile([record], [live({ name: "pulsar-migra", running: false })]);
		expect(stateOf(rows, "pulsar-migra")).toBe("failed");
	});

	test("sync parado continua 'parado' mesmo com lastRun ok", () => {
		// sync não "conclui": parar um sync é parar, não terminar.
		const record = {
			...base,
			lastRun: {
				startedAt: "2026-08-15T10:00:00Z",
				endedAt: "2026-08-15T10:45:00Z",
				status: "ok" as const,
				exitCode: 0,
				stats: {},
				error: null,
			},
		};
		expect(stateOf(reconcile([record], [live({ running: false })]), "pulsar-ads")).toBe(
			"stopped",
		);
	});

	test("no ar primeiro, depois em ordem de nome", () => {
		const rows = reconcile(
			[base, { ...base, name: "pulsar-aaa" }],
			[live({ name: "pulsar-ads" }), live({ name: "pulsar-aaa", running: false })],
		);
		expect(rows.map((r) => r.name)).toEqual(["pulsar-ads", "pulsar-aaa"]);
	});

	test("isOneShot", () => {
		expect(isOneShot("migrate")).toBe(true);
		expect(isOneShot("ttl")).toBe(true);
		expect(isOneShot("sync")).toBe(false);
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/state.test.ts`
Expected: FAIL — `reconcile` não existe.

- [ ] **Step 3: Implementar**

Criar `src/core/state/reconcile.ts`:

```ts
import type { RunMode } from "../run/pulsarCommand";
import type { DiscoveredService } from "../service/discover";
import type { ServiceRecord } from "./registry";

/**
 * A lista da tela é o cruzamento de duas fontes que sabem coisas diferentes.
 *
 * O registro sabe o SIGNIFICADO (é um migrate, aponta para este yml, copiou
 * 1.2M docs). O supervisor sabe a VERDADE VIVA (está no ar agora, sobe no
 * boot). Nenhuma das duas basta, e as duas podem discordar — serviço removido
 * à mão, registro apagado, TUI antiga. Os quatro casos aparecem na lista, com
 * ações diferentes, em vez de um deles sumir e o usuário achar que perdeu algo.
 */

export type ServiceState =
	| "running"
	| "stopped"
	| "done"
	| "failed"
	| "uninstalled"
	| "adopted";

export type ServiceRow = {
	name: string;
	state: ServiceState;
	record: ServiceRecord | null;
	live: DiscoveredService | null;
};

/** `migrate` e `ttl` terminam; `sync` não. */
export function isOneShot(mode: RunMode): boolean {
	return mode === "migrate" || mode === "ttl";
}

export function reconcile(
	records: ServiceRecord[],
	live: DiscoveredService[],
): ServiceRow[] {
	const byName = new Map(live.map((service) => [service.name, service]));
	const seen = new Set<string>();
	const rows: ServiceRow[] = [];

	for (const record of records) {
		const found = byName.get(record.name) ?? null;
		seen.add(record.name);
		rows.push({
			name: record.name,
			state: stateFor(record, found),
			record,
			live: found,
		});
	}

	for (const service of live) {
		if (seen.has(service.name)) continue;
		rows.push({
			name: service.name,
			state: "adopted",
			record: null,
			live: service,
		});
	}

	return rows.sort(
		(a, b) =>
			Number(b.state === "running") - Number(a.state === "running") ||
			a.name.localeCompare(b.name),
	);
}

function stateFor(
	record: ServiceRecord,
	live: DiscoveredService | null,
): ServiceState {
	if (!live) return "uninstalled";
	if (live.running) return "running";

	// Parado é ambíguo: um sync parado foi PARADO, um migrate parado TERMINOU.
	// Só o modo e o resultado distinguem, e é essa distinção que o usuário vê.
	if (isOneShot(record.mode) && record.lastRun?.status === "ok") return "done";
	if (isOneShot(record.mode) && record.lastRun?.status === "error")
		return "failed";

	return "stopped";
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test test/state.test.ts`
Expected: PASS (28 no arquivo).

- [ ] **Step 5: Commitar**

```bash
bunx biome check --write src test
git add src/core/state/reconcile.ts test/state.test.ts
git commit -m "feat(core): reconcilia registro com o supervisor"
```

---

### Task 7: Passos com sudo resolvidos na instalação

**Files:**
- Create: `src/core/service/privileged.ts`
- Modify: `src/core/service/manager.ts` (linhas 156-191)
- Test: `test/privileged.test.ts`

**Interfaces:**
- Consumes: `ServiceStep`, `InstallPlan`, `ServiceSpec` de `src/core/service/types.ts`; `execStep`, `StepResult` de `src/core/service/manager.ts`; `withTerminal` da Task 2
- Produces:
  - `type SudoMode = "passwordless" | "needs-password" | "unavailable"`
  - `detectSudo(probe?: () => Promise<boolean>): Promise<SudoMode>`
  - `type PrivilegedDecision = "run" | "ask" | "skip"`
  - `type AskCallback = (step: ServiceStep) => Promise<boolean>`
  - `runPrivilegedStep(step, opts: { cwd: string; sudo: SudoMode; ask: AskCallback; onOutput?: (line: string) => void }): Promise<StepResult | null>` — `null` quando o usuário pulou
  - `installService(plan, spec, opts?)` passa a aceitar `{ onOutput?, sudo?, ask? }`

- [ ] **Step 1: Escrever os testes**

Acrescentar a `test/privileged.test.ts`:

```ts
import { detectSudo, runPrivilegedStep } from "../src/core/service/privileged";
import type { ServiceStep } from "../src/core/service/types";

const step: ServiceStep = {
	cmd: "sudo",
	args: ["loginctl", "enable-linger", "padawan"],
	why: "permite subir no boot",
	privileged: true,
};

describe("detectSudo", () => {
	test("sudo -n passando é passwordless", async () => {
		expect(await detectSudo(async () => true)).toBe("passwordless");
	});

	test("sudo -n falhando pede senha", async () => {
		expect(await detectSudo(async () => false)).toBe("needs-password");
	});
});

describe("runPrivilegedStep", () => {
	test("sem senha, roda sem perguntar nada", async () => {
		let perguntou = false;
		const result = await runPrivilegedStep(
			{ cmd: "true", args: [], why: "x", privileged: true },
			{
				cwd: process.cwd(),
				sudo: "passwordless",
				ask: async () => {
					perguntou = true;
					return true;
				},
			},
		);
		expect(perguntou).toBe(false);
		expect(result?.ok).toBe(true);
	});

	test("com senha, pergunta ANTES de rodar", async () => {
		const vistos: ServiceStep[] = [];
		await runPrivilegedStep(
			{ cmd: "true", args: [], why: "x", privileged: true },
			{
				cwd: process.cwd(),
				sudo: "needs-password",
				ask: async (s) => {
					vistos.push(s);
					return true;
				},
			},
		);
		// O usuário vê o comando literal antes de qualquer coisa acontecer.
		expect(vistos).toHaveLength(1);
		expect(vistos[0]?.cmd).toBe("true");
	});

	test("recusar devolve null e não roda", async () => {
		const result = await runPrivilegedStep(
			{ cmd: "false", args: [], why: "x", privileged: true },
			{ cwd: process.cwd(), sudo: "needs-password", ask: async () => false },
		);
		expect(result).toBeNull();
	});
});

describe("installService com passo privilegiado", () => {
	test("pular o privilegiado não falha a instalação", async () => {
		// Era o comportamento antigo travestido de erro: o serviço subia, mas o
		// relatório dizia que a instalação tinha falhado.
		const { installService } = await import("../src/core/service/manager");
		const plan = {
			backend: "systemd" as const,
			serviceName: "pulsar-x",
			files: [],
			steps: [
				{ cmd: "true", args: [], why: "passo normal" },
				{ cmd: "true", args: [], why: "passo root", privileged: true },
			],
			manualSteps: [],
			notes: [],
		};
		const spec = {
			name: "x",
			mode: "sync" as const,
			configPath: "/tmp/x.yml",
			workingDir: "/tmp",
			autostart: true,
		};

		const result = await installService(plan, spec, {
			sudo: "needs-password",
			ask: async () => false,
		});
		expect(result.ok).toBe(true);
		expect(result.skippedPrivileged).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/privileged.test.ts`
Expected: FAIL — `privileged` não existe; `installService` não aceita `opts`.

- [ ] **Step 3: Criar `src/core/service/privileged.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTerminal } from "../tty/handoff";
import { execStep, type StepResult } from "./manager";
import type { ServiceStep } from "./types";

const run = promisify(execFile);

/**
 * Sudo resolvido DURANTE a instalação, não relatado como pendência no fim.
 *
 * O comportamento anterior era `if (step.privileged) continue;`: o passo era
 * pulado em silêncio e, no fim de tudo, a tela informava que não tinha dado
 * porque precisava de sudo. A informação existia desde antes de começar e era
 * guardada até o pior momento possível. Aqui ela é usada no começo: se `sudo -n`
 * passa, roda direto; se não passa, pergunta na hora, mostrando o comando
 * literal — e "não" é uma resposta válida que não faz a instalação falhar.
 */

export type SudoMode = "passwordless" | "needs-password" | "unavailable";

/** `sudo -n true` sai 0 só quando não haveria prompt de senha. */
export async function detectSudo(
	probe: () => Promise<boolean> = async () => {
		try {
			await run("sudo", ["-n", "true"], { timeout: 4000 });
			return true;
		} catch {
			return false;
		}
	},
): Promise<SudoMode> {
	return (await probe()) ? "passwordless" : "needs-password";
}

export type AskCallback = (step: ServiceStep) => Promise<boolean>;

/**
 * Devolve `null` quando o usuário escolheu pular — que é diferente de falhar.
 */
export async function runPrivilegedStep(
	step: ServiceStep,
	opts: {
		cwd: string;
		sudo: SudoMode;
		ask: AskCallback;
		onOutput?: (line: string) => void;
	},
): Promise<StepResult | null> {
	if (opts.sudo === "unavailable") return null;

	if (opts.sudo === "passwordless")
		return execStep(step, { cwd: opts.cwd, onOutput: opts.onOutput });

	if (!(await opts.ask(step))) return null;

	// O sudo precisa do terminal de verdade para desenhar o prompt de senha e
	// ler sem eco. `withTerminal` sai do alternate screen, entrega o TTY e
	// restaura em finally.
	return withTerminal(() =>
		execStep(step, { cwd: opts.cwd, onOutput: opts.onOutput }),
	);
}
```

- [ ] **Step 4: Alterar `installService` em `manager.ts`**

Substituir a assinatura e o laço (linhas 156-191) por:

```ts
export type InstallResult = {
	plan: InstallPlan;
	files: string[];
	results: StepResult[];
	/** passos com sudo que o usuário optou por não rodar agora */
	skippedPrivileged: ServiceStep[];
	ok: boolean;
};

export async function installService(
	plan: InstallPlan,
	spec: ServiceSpec,
	opts?: {
		onOutput?: (line: string) => void;
		sudo?: SudoMode;
		ask?: AskCallback;
	},
): Promise<InstallResult> {
	const written: string[] = [];

	for (const file of plan.files) {
		mkdirSync(dirname(file.path), { recursive: true });
		writeFileSync(file.path, file.content, { mode: file.mode ?? 0o644 });
		written.push(file.path);
	}

	mkdirSync(join(spec.workingDir, "logs"), { recursive: true });

	const results: StepResult[] = [];
	const skippedPrivileged: ServiceStep[] = [];
	let ok = true;

	for (const step of plan.steps) {
		const result = step.privileged
			? await runPrivilegedStep(step, {
					cwd: spec.workingDir,
					sudo: opts?.sudo ?? "needs-password",
					ask: opts?.ask ?? (async () => false),
					onOutput: opts?.onOutput,
				})
			: await execStep(step, { cwd: spec.workingDir, onOutput: opts?.onOutput });

		// Pular um passo com sudo é uma escolha, não uma falha: o serviço sobe
		// mesmo assim e só o boot fica pendente.
		if (result === null) {
			skippedPrivileged.push(step);
			continue;
		}

		results.push(result);

		if (!result.ok && !step.optional) {
			ok = false;
			break;
		}
	}

	return { plan, files: written, results, skippedPrivileged, ok };
}
```

Acrescentar o import no topo de `manager.ts`:

```ts
import { type AskCallback, runPrivilegedStep, type SudoMode } from "./privileged";
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test test/privileged.test.ts test/tuiService.test.ts`
Expected: PASS. Se `tuiService.test.ts` quebrar por causa da nova propriedade `skippedPrivileged`, ajuste as asserções — o campo é aditivo e nenhum teste existente deveria depender da ausência dele.

- [ ] **Step 6: Commitar**

```bash
bunx biome check --write src test
git add src/core/service/privileged.ts src/core/service/manager.ts test/privileged.test.ts
git commit -m "feat(core): resolve os passos com sudo durante a instalação"
```

---

### Task 8: One-shot desliga o próprio boot

**Files:**
- Create: `src/core/service/oneshot.ts`
- Modify: `src/core/state/runRecord.ts`
- Test: `test/privileged.test.ts`

**Interfaces:**
- Consumes: `ServiceRecord`, `CREATED_BY_TUI`, `readRecord`, `writeRecord` (Task 3); `isOneShot` (Task 6); `execStep` (`manager.ts`)
- Produces:
  - `disableBootSteps(record: ServiceRecord): ServiceStep[]`
  - `shouldDisableBoot(record: ServiceRecord, status: "ok" | "error"): boolean`
  - `disableBootAfterSuccess(name: string, status, home?): Promise<void>`

- [ ] **Step 1: Escrever os testes**

Acrescentar a `test/privileged.test.ts`:

```ts
import { disableBootSteps, shouldDisableBoot } from "../src/core/service/oneshot";
import { CREATED_BY_TUI, type ServiceRecord } from "../src/core/state/registry";

const oneShot: ServiceRecord = {
	name: "pulsar-migra",
	mode: "migrate",
	config: "/srv/m.yml",
	workingDir: "/srv",
	backend: "systemd",
	boot: true,
	createdBy: CREATED_BY_TUI,
	lastRun: null,
};

describe("shouldDisableBoot", () => {
	test("one-shot criado pelo pulsar, concluído com sucesso: desliga", () => {
		expect(shouldDisableBoot(oneShot, "ok")).toBe(true);
	});

	test("erro NÃO desliga — senão a retentativa some sem ninguém saber", () => {
		expect(shouldDisableBoot(oneShot, "error")).toBe(false);
	});

	test("serviço que o pulsar não criou fica intocado", () => {
		expect(shouldDisableBoot({ ...oneShot, createdBy: "adotado" }, "ok")).toBe(false);
	});

	test("sync nunca desliga o boot", () => {
		expect(shouldDisableBoot({ ...oneShot, mode: "sync" }, "ok")).toBe(false);
	});

	test("boot já desligado não faz nada", () => {
		expect(shouldDisableBoot({ ...oneShot, boot: false }, "ok")).toBe(false);
	});
});

describe("disableBootSteps", () => {
	test("systemd", () => {
		const [step] = disableBootSteps(oneShot);
		expect(step?.cmd).toBe("systemctl");
		expect(step?.args).toEqual(["--user", "disable", "pulsar-migra.service"]);
	});

	test("docker", () => {
		const [step] = disableBootSteps({ ...oneShot, backend: "docker" });
		expect(step?.cmd).toBe("docker");
		expect(step?.args).toEqual(["update", "--restart=no", "pulsar-migra"]);
	});

	test("pm2 remove e salva", () => {
		const steps = disableBootSteps({ ...oneShot, backend: "pm2" });
		expect(steps.map((s) => s.args.join(" "))).toEqual([
			"delete pulsar-migra",
			"save",
		]);
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/privileged.test.ts`
Expected: FAIL — `oneshot` não existe.

- [ ] **Step 3: Implementar**

Criar `src/core/service/oneshot.ts`:

```ts
import { readRecord, type ServiceRecord, writeRecord } from "../state/registry";
import { CREATED_BY_TUI } from "../state/registry";
import { isOneShot } from "../state/reconcile";
import { agentLabel } from "./launchd";
import { execStep } from "./manager";
import type { ServiceStep } from "./types";

/**
 * `migrate` e `ttl` terminam — e um serviço que terminou não deve subir de novo
 * a cada reinício da máquina, re-executando a migração inteira.
 *
 * Quem desliga é o próprio processo, ao concluir: a TUI pode estar fechada, e
 * frequentemente está. Duas travas impedem que isso vire surpresa: só mexe em
 * serviço que o PULSAR criou (`createdBy`), e só no SUCESSO — desligar no erro
 * tiraria a retentativa sem ninguém perceber.
 */

export function shouldDisableBoot(
	record: ServiceRecord,
	status: "ok" | "error",
): boolean {
	if (status !== "ok") return false;
	if (!record.boot) return false;
	if (!isOneShot(record.mode)) return false;
	return record.createdBy === CREATED_BY_TUI;
}

export function disableBootSteps(record: ServiceRecord): ServiceStep[] {
	const why = "one-shot concluído: não subir mais no boot";

	switch (record.backend) {
		case "systemd":
			return [
				{
					cmd: "systemctl",
					args: ["--user", "disable", `${record.name}.service`],
					why,
				},
			];
		case "docker":
			return [
				{ cmd: "docker", args: ["update", "--restart=no", record.name], why },
			];
		case "pm2":
			return [
				{ cmd: "pm2", args: ["delete", record.name], why },
				{ cmd: "pm2", args: ["save"], why },
			];
		case "launchd":
			return [
				{
					cmd: "launchctl",
					args: [
						"bootout",
						`gui/${process.getuid?.() ?? 501}/${agentLabel({ name: record.name })}`,
					],
					why,
				},
			];
	}
}

export async function disableBootAfterSuccess(
	name: string,
	status: "ok" | "error",
	home?: string,
): Promise<void> {
	const record = readRecord(name, home);
	if (!record || !shouldDisableBoot(record, status)) return;

	for (const step of disableBootSteps(record))
		await execStep(step, { cwd: record.workingDir });

	writeRecord({ ...record, boot: false }, home);
}
```

Se `agentLabel` exigir um `ServiceSpec` completo em vez de `{ name }`, ajuste a chamada montando o spec a partir do record (`{ name: record.name, mode: record.mode, configPath: record.config, workingDir: record.workingDir, autostart: record.boot }`).

- [ ] **Step 4: Chamar do `finishRun`**

Em `src/core/state/runRecord.ts`, ao fim de `finishRun`, depois de gravar:

```ts
// Fora do caminho síncrono: o comando já terminou e não deve esperar o
// supervisor responder para poder sair.
void disableBootAfterSuccess(name, outcome.status, home).catch(() => {});
```

com o import correspondente. Se isso criar ciclo de import (`oneshot` → `registry` → `runRecord` → `oneshot`), quebre movendo a chamada para os três comandos, logo depois de `finishRun`.

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test test/privileged.test.ts test/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commitar**

```bash
bunx biome check --write src test
git add src/core/service/oneshot.ts src/core/state/runRecord.ts test/privileged.test.ts
git commit -m "feat(core): one-shot concluído desliga o próprio boot"
```

---

### Task 9: Trocar de backend com rollback

**Files:**
- Create: `src/core/service/switchBackend.ts`
- Test: `test/privileged.test.ts`

**Interfaces:**
- Consumes: `buildPlan`, `installService`, `uninstallService` (`manager.ts`); `ServiceRecord`, `writeRecord` (Task 3); `SudoMode`, `AskCallback` (Task 7)
- Produces:
  - `type SwitchOutcome = { ok: true; record: ServiceRecord } | { ok: false; error: string; rolledBack: boolean }`
  - `switchBackend(record, target: Backend, opts): Promise<SwitchOutcome>`

- [ ] **Step 1: Escrever os testes**

Acrescentar a `test/privileged.test.ts`. Os testes injetam as operações, para não precisar de supervisor:

```ts
import { switchBackend } from "../src/core/service/switchBackend";

const record: ServiceRecord = { ...oneShot, mode: "sync", backend: "systemd" };

describe("switchBackend", () => {
	test("caminho feliz: desinstala do antigo, instala no novo, atualiza o registro", async () => {
		const ordem: string[] = [];
		const result = await switchBackend(record, "docker", {
			home: undefined,
			uninstall: async (backend) => void ordem.push(`uninstall:${backend}`),
			install: async (backend) => {
				ordem.push(`install:${backend}`);
				return { ok: true };
			},
			save: (r) => void ordem.push(`save:${r.backend}`),
		});

		expect(ordem).toEqual(["uninstall:systemd", "install:docker", "save:docker"]);
		expect(result.ok).toBe(true);
	});

	test("falhando no novo, volta para o antigo", async () => {
		// Sem isto, um docker mal configurado deixaria o usuário sem serviço
		// nenhum: o antigo já foi removido quando o novo falhou.
		const ordem: string[] = [];
		const result = await switchBackend(record, "docker", {
			home: undefined,
			uninstall: async (backend) => void ordem.push(`uninstall:${backend}`),
			install: async (backend) => {
				ordem.push(`install:${backend}`);
				return backend === "docker"
					? { ok: false, error: "daemon não responde" }
					: { ok: true };
			},
			save: () => {},
		});

		expect(ordem).toEqual([
			"uninstall:systemd",
			"install:docker",
			"install:systemd",
		]);
		expect(result).toEqual({
			ok: false,
			error: "daemon não responde",
			rolledBack: true,
		});
	});

	test("se nem o rollback funciona, diz isso em vez de mentir", async () => {
		const result = await switchBackend(record, "docker", {
			home: undefined,
			uninstall: async () => {},
			install: async () => ({ ok: false, error: "nada funciona" }),
			save: () => {},
		});
		expect(result).toEqual({
			ok: false,
			error: "nada funciona",
			rolledBack: false,
		});
	});

	test("trocar para o mesmo backend não faz nada", async () => {
		const ordem: string[] = [];
		const result = await switchBackend(record, "systemd", {
			home: undefined,
			uninstall: async () => void ordem.push("uninstall"),
			install: async () => {
				ordem.push("install");
				return { ok: true };
			},
			save: () => {},
		});
		expect(ordem).toEqual([]);
		expect(result.ok).toBe(true);
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/privileged.test.ts`
Expected: FAIL — `switchBackend` não existe.

- [ ] **Step 3: Implementar**

Criar `src/core/service/switchBackend.ts`:

```ts
import { type ServiceRecord, writeRecord } from "../state/registry";
import { buildPlan, installService, uninstallService } from "./manager";
import type { AskCallback, SudoMode } from "./privileged";
import type { Backend, ServiceSpec } from "./types";

/**
 * Migrar um serviço de supervisor sem deixar o usuário sem serviço nenhum.
 *
 * A troca é destrutiva por natureza: para instalar no novo é preciso remover do
 * antigo, e é exatamente no meio disso que uma falha do novo backend (daemon do
 * docker fora do ar, pm2 sem permissão) deixaria a máquina sem nada rodando. O
 * rollback reinstala o antigo — e quando nem isso funciona, o resultado diz
 * `rolledBack: false` em vez de fingir que está tudo bem.
 *
 * As operações entram por parâmetro para o teste não precisar de supervisor.
 */

export type SwitchOutcome =
	| { ok: true; record: ServiceRecord }
	| { ok: false; error: string; rolledBack: boolean };

export type SwitchOps = {
	home?: string;
	uninstall: (backend: Backend, record: ServiceRecord) => Promise<void>;
	install: (
		backend: Backend,
		record: ServiceRecord,
	) => Promise<{ ok: true } | { ok: false; error: string }>;
	save: (record: ServiceRecord) => void;
};

export function defaultOps(opts: {
	sudo: SudoMode;
	ask: AskCallback;
	home?: string;
}): SwitchOps {
	const toSpec = (record: ServiceRecord): ServiceSpec => ({
		name: record.name.replace(/^pulsar-/, ""),
		mode: record.mode,
		configPath: record.config,
		workingDir: record.workingDir,
		autostart: record.boot,
	});

	return {
		home: opts.home,
		uninstall: async (backend, record) => {
			await uninstallService(backend, toSpec(record));
		},
		install: async (backend, record) => {
			const plan = buildPlan(backend, toSpec(record));
			if ("error" in plan) return { ok: false, error: plan.error };

			const result = await installService(plan, toSpec(record), {
				sudo: opts.sudo,
				ask: opts.ask,
			});
			return result.ok
				? { ok: true }
				: {
						ok: false,
						error:
							result.results.find((r) => !r.ok)?.output ??
							"a instalação falhou sem mensagem",
					};
		},
		save: (record) => writeRecord(record, opts.home),
	};
}

export async function switchBackend(
	record: ServiceRecord,
	target: Backend,
	ops: SwitchOps,
): Promise<SwitchOutcome> {
	if (record.backend === target) return { ok: true, record };

	const previous = record.backend;
	await ops.uninstall(previous, record);

	const installed = await ops.install(target, { ...record, backend: target });
	if (installed.ok) {
		const updated = { ...record, backend: target };
		ops.save(updated);
		return { ok: true, record: updated };
	}

	const back = await ops.install(previous, record);
	return { ok: false, error: installed.error, rolledBack: back.ok };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test test/privileged.test.ts`
Expected: PASS.

- [ ] **Step 5: Commitar**

```bash
bunx biome check --write src test
git add src/core/service/switchBackend.ts test/privileged.test.ts
git commit -m "feat(core): troca de backend com rollback para o anterior"
```

---

### Task 10: Registro de teclas e ajuda contextual (`?`)

**Files:**
- Create: `src/tui/keys.ts`, `src/tui/components/HelpOverlay.tsx`
- Test: `test/tuiKeys.test.ts`

**Interfaces:**
- Consumes: `Overlay` (Task 1), `theme`
- Produces:
  - `type KeyBinding = { keys: string; label: string; group: string; primary?: boolean }`
  - `type Layer = "list" | "detail" | "form" | "logs" | "help"`
  - `KEYS: Record<Layer, KeyBinding[]>`
  - `GLOBAL_KEYS: KeyBinding[]`
  - `hintsFor(layer: Layer): Hint[]` — só os `primary`, para a barra
  - `helpFor(layer: Layer): { group: string; keys: KeyBinding[] }[]` — todos, agrupados
  - `<HelpOverlay layer columns rows />`

- [ ] **Step 1: Escrever os testes**

Acrescentar a `test/tuiKeys.test.ts`:

```ts
import { GLOBAL_KEYS, helpFor, hintsFor, KEYS, type Layer } from "../src/tui/keys";

const LAYERS: Layer[] = ["list", "detail", "form", "logs"];

describe("keys", () => {
	test("toda camada declara pelo menos uma tecla primária", () => {
		for (const layer of LAYERS)
			expect(hintsFor(layer).length).toBeGreaterThan(0);
	});

	test("a barra mostra menos teclas do que a ajuda", () => {
		// É a razão de o `?` existir: a barra não cabe tudo.
		for (const layer of LAYERS) {
			const naAjuda = helpFor(layer).flatMap((g) => g.keys).length;
			expect(hintsFor(layer).length).toBeLessThanOrEqual(naAjuda);
		}
	});

	test("nenhuma tecla duplicada dentro da mesma camada", () => {
		for (const layer of LAYERS) {
			const keys = KEYS[layer].map((k) => k.keys);
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	test("camada nenhuma redefine uma tecla global", () => {
		// `ctrl+d` sair e `?` ajuda precisam significar a mesma coisa em todo lugar.
		const globais = new Set(GLOBAL_KEYS.map((k) => k.keys));
		for (const layer of LAYERS)
			for (const binding of KEYS[layer])
				expect(globais.has(binding.keys)).toBe(false);
	});

	test("a ajuda de toda camada termina com as globais", () => {
		for (const layer of LAYERS) {
			const grupos = helpFor(layer);
			expect(grupos.at(-1)?.group).toBe("sempre");
			expect(grupos.at(-1)?.keys).toEqual(GLOBAL_KEYS);
		}
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/tuiKeys.test.ts`
Expected: FAIL — `keys.ts` não existe.

- [ ] **Step 3: Implementar `src/tui/keys.ts`**

```ts
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
		{ keys: "enter", label: "abrir o serviço", group: "navegar", primary: true },
		{ keys: "n", label: "novo serviço", group: "serviço", primary: true },
		{ keys: "l", label: "logs", group: "serviço", primary: true },
		{ keys: "i", label: "iniciar", group: "serviço" },
		{ keys: "p", label: "parar", group: "serviço" },
		{ keys: "t", label: "reiniciar", group: "serviço" },
		{ keys: "R", label: "recarregar a lista", group: "serviço" },
		{ keys: "ctrl+c", label: "copiar o nome", group: "copiar" },
		{ keys: "m", label: "mouse on/off", group: "copiar" },
		{ keys: "q", label: "sair", group: "sair", primary: true },
	],
	detail: [
		{ keys: "i", label: "iniciar", group: "controlar", primary: true },
		{ keys: "p", label: "parar", group: "controlar", primary: true },
		{ keys: "t", label: "reiniciar", group: "controlar" },
		{ keys: "▶", label: "rodar agora aqui", group: "controlar", primary: true },
		{ keys: "b", label: "trocar inicialização", group: "configurar" },
		{ keys: "e", label: "editar", group: "configurar", primary: true },
		{ keys: "x", label: "remover", group: "configurar" },
		{ keys: "l", label: "logs", group: "ver", primary: true },
		{ keys: "v", label: "ver resultado / erro", group: "ver" },
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
		{ keys: "ctrl+c", label: "copiar a linha em foco", group: "copiar", primary: true },
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

export function helpFor(
	layer: Layer,
): { group: string; keys: KeyBinding[] }[] {
	const groups: { group: string; keys: KeyBinding[] }[] = [];

	for (const binding of KEYS[layer]) {
		const existing = groups.find((g) => g.group === binding.group);
		if (existing) existing.keys.push(binding);
		else groups.push({ group: binding.group, keys: [binding] });
	}

	groups.push({ group: "sempre", keys: GLOBAL_KEYS });
	return groups;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test test/tuiKeys.test.ts`
Expected: PASS (8 testes no arquivo).

- [ ] **Step 5: Implementar `HelpOverlay`**

Criar `src/tui/components/HelpOverlay.tsx`:

```tsx
import { Box, Text } from "ink";
import { helpFor, type Layer } from "../keys";
import { theme } from "../theme";
import { Overlay } from "./Overlay";

/**
 * A ajuda é CONTEXTUAL: mostra as teclas da camada em que a pessoa está, com
 * as globais no fim. Um help único listando tudo de todas as telas é o tipo de
 * coisa que ninguém lê duas vezes.
 */
export function HelpOverlay({
	layer,
	columns,
	rows,
}: {
	layer: Layer;
	columns: number;
	rows: number;
}) {
	const titles: Record<Layer, string> = {
		list: "serviços",
		detail: "serviço",
		form: "formulário",
		logs: "logs",
		help: "ajuda",
	};

	return (
		<Overlay title={`teclas · ${titles[layer]}`} columns={columns} rows={rows}>
			{helpFor(layer).map((group) => (
				<Box key={group.group} flexDirection="column" marginBottom={1}>
					<Text color={theme.muted}>{group.group}</Text>
					{group.keys.map((binding) => (
						<Text key={binding.keys} wrap="truncate-end">
							{"  "}
							<Text color={theme.accent} bold>
								{binding.keys.padEnd(12)}
							</Text>
							<Text color={theme.label}>{binding.label}</Text>
						</Text>
					))}
				</Box>
			))}
		</Overlay>
	);
}
```

- [ ] **Step 6: Commitar**

```bash
bunx biome check --write src test
git add src/tui/keys.ts src/tui/components/HelpOverlay.tsx test/tuiKeys.test.ts
git commit -m "feat(tui): registro único de teclas e ajuda contextual"
```

---

### Task 11: Tela raiz — lista de serviços

**Files:**
- Create: `src/tui/screens/ServicesPanel.tsx`
- Modify: `src/tui/components/Shell.tsx`
- Test: manual (a lista é casca sobre `reconcile`, já testado na Task 6)

**Interfaces:**
- Consumes: `reconcile`, `ServiceRow`, `ServiceState` (Task 6); `listRecords` (Task 3); `discoverServices`; `hintsFor` (Task 10); `Overlay`
- Produces:
  - `<ServicesPanel dir={string} onOpen={(row: ServiceRow) => void} onNew={() => void} onLogs={(row) => void} onQuit={() => void} />`
  - `useServiceRows(reloadKey: number): { rows: ServiceRow[]; loading: boolean }`

- [ ] **Step 1: Acrescentar a prop `overlay` ao `Shell`**

Em `src/tui/components/Shell.tsx`, na assinatura de `Shell`, acrescentar `overlay?: ReactNode` e renderizar depois do corpo:

```tsx
		<Box flexDirection="column" width={columns} height={rows}>
			<Header chips={chips} columns={columns} />
			<Box flexDirection="row" flexGrow={1}>
				{children}
			</Box>
			{overlay}
			<KeyBar hints={hints} notice={toast ?? notice} />
		</Box>
```

O overlay entra **depois** do corpo para ser desenhado por cima; como é `position="absolute"`, não empurra a `KeyBar`.

- [ ] **Step 2: Implementar o hook de dados**

Criar `src/tui/screens/ServicesPanel.tsx` começando pelo hook:

```tsx
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { discoverServices } from "../../core/service/discover";
import { listRecords } from "../../core/state/registry";
import { reconcile, type ServiceRow } from "../../core/state/reconcile";
import { isMouseInput } from "../mouse/parse";
import { useClickable } from "../mouse/MouseProvider";
import { theme } from "../theme";

/**
 * A lista de serviços é a tela raiz — não há mais "tela inicial" separada.
 *
 * Ela é GLOBAL à máquina: serviço não pertence a uma pasta, e abrir a TUI em
 * outro diretório não pode fazer serviço sumir. Só a lista de ymls do
 * formulário depende do diretório atual.
 */

export function useServiceRows(reloadKey: number) {
	const [rows, setRows] = useState<ServiceRow[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let alive = true;
		setLoading(true);

		void (async () => {
			// O registro é síncrono (arquivos locais); a descoberta consulta quatro
			// supervisores e é a parte lenta — daí o estado de carregando.
			const records = listRecords();
			const live = await discoverServices();
			if (!alive) return;
			setRows(reconcile(records, live));
			setLoading(false);
		})();

		return () => {
			alive = false;
		};
	}, [reloadKey]);

	return { rows, loading };
}
```

- [ ] **Step 3: Implementar a linha e a lista**

No mesmo arquivo:

```tsx
const STATE_GLYPH = {
	running: { icon: "●", tone: theme.ok, label: "no ar" },
	stopped: { icon: "○", tone: theme.muted, label: "parado" },
	done: { icon: "✓", tone: theme.ok, label: "concluído" },
	failed: { icon: "✗", tone: theme.error, label: "erro" },
	uninstalled: { icon: "⊘", tone: theme.warn, label: "não instalado" },
	adopted: { icon: "◍", tone: theme.warn, label: "adotado" },
} as const;

function Row({
	row,
	width,
	selected,
}: {
	row: ServiceRow;
	width: number;
	selected: boolean;
}) {
	const state = STATE_GLYPH[row.state];
	const mode = row.record?.mode ?? "—";
	const backend = row.record?.backend ?? row.live?.backend ?? "—";
	const boot = row.record?.boot || row.live?.enabled ? "boot" : "—";

	return (
		<Text
			wrap="truncate-end"
			color={selected ? theme.selection : theme.label}
			bold={selected}
		>
			{selected ? "▍" : " "}
			<Text color={state.tone}>{state.icon} </Text>
			{row.name.padEnd(Math.max(10, Math.min(28, width - 40)))}
			<Text color={theme.muted}>
				{" "}
				{mode.padEnd(8)}
				{backend.padEnd(9)}
				{boot.padEnd(6)}
				{state.label}
			</Text>
		</Text>
	);
}
```

- [ ] **Step 4: Implementar o componente e o teclado**

```tsx
export function ServicesPanel({
	rows,
	loading,
	columns,
	rows: screenRows,
	cursor,
	setCursor,
	onOpen,
	onNew,
	onLogs,
	onQuit,
	onReload,
	enabled,
}: {
	rows: ServiceRow[];
	loading: boolean;
	columns: number;
	screenRows: number;
	cursor: number;
	setCursor: (i: number) => void;
	onOpen: (row: ServiceRow) => void;
	onNew: () => void;
	onLogs: (row: ServiceRow) => void;
	onQuit: () => void;
	onReload: () => void;
	/** false quando um overlay está por cima — só a camada de cima escuta */
	enabled: boolean;
}) {
	const selected = rows[cursor];

	useInput(
		(input, key) => {
			if (isMouseInput(input)) return;
			if (key.upArrow) setCursor(cursor === 0 ? rows.length - 1 : cursor - 1);
			if (key.downArrow) setCursor(cursor === rows.length - 1 ? 0 : cursor + 1);
			if (key.return && selected) onOpen(selected);
			if (input === "n") onNew();
			if (input === "l" && selected) onLogs(selected);
			if (input === "R") onReload();
			if (input === "q") onQuit();
		},
		{ isActive: enabled },
	);

	const listRef = useClickable({
		onClick: ({ row }) => {
			const index = row - 1;
			if (index >= 0 && index < rows.length) {
				setCursor(index);
				const target = rows[index];
				if (target) onOpen(target);
			}
		},
	});

	if (loading)
		return <Text color={theme.muted}>procurando serviços na máquina…</Text>;

	if (rows.length === 0)
		return (
			<Box flexDirection="column">
				<Text color={theme.muted}>nenhum serviço do pulsar nesta máquina.</Text>
				<Text> </Text>
				<Text>
					<Text color={theme.accent} bold>
						n
					</Text>
					<Text color={theme.muted}> cria o primeiro</Text>
				</Text>
			</Box>
		);

	return (
		<Box ref={listRef} flexDirection="column">
			{rows.map((row, i) => (
				<Row key={row.name} row={row} width={columns} selected={i === cursor} />
			))}
		</Box>
	);
}
```

A prop `enabled` é o mecanismo que substitui o `tab`: com um overlay aberto, o `useInput` da lista fica inativo (`isActive: false`) e só a camada de cima recebe tecla. Isso mata a classe de bug em que `enter` agia no painel errado.

- [ ] **Step 5: Verificar no terminal**

Depois da Task 15 a TUI inteira estará ligada; por ora, verifique que `bun test` continua passando e que o TypeScript compila:

Run: `bunx tsc --noEmit && bun test`
Expected: sem erro de tipo; todos os testes passando.

- [ ] **Step 6: Commitar**

```bash
bunx biome check --write src test
git add src/tui/screens/ServicesPanel.tsx src/tui/components/Shell.tsx
git commit -m "feat(tui): lista de serviços como tela raiz"
```

---

### Task 12: Overlay de detalhe do serviço

**Files:**
- Create: `src/tui/screens/ServiceDetail.tsx`
- Test: manual

**Interfaces:**
- Consumes: `ServiceRow` (Task 6); `controlService` (`manager.ts`); `Overlay`; `hintsFor("detail")`
- Produces:
  - `<ServiceDetail row onClose onEdit onLogs onRun onSwitchBackend onRemove columns rows />`
  - `formatStats(record: ServiceRecord): string[]` — as linhas de "ver resultado", por modo

- [ ] **Step 1: Implementar `formatStats`**

Em `src/tui/screens/ServiceDetail.tsx`:

```tsx
import type { ServiceRecord } from "../../core/state/registry";

/**
 * O resultado de um one-shot, em linguagem de gente.
 *
 * Os nomes dos contadores mudam por modo (um ttl não "insere documentos", cria
 * índices), então a tradução é por modo — mostrar `materialized: 0` para um
 * sync seria ruído.
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
		([key, value]) => `${dictionary[key] ?? key}: ${value.toLocaleString("pt-BR")}`,
	);
}
```

- [ ] **Step 2: Implementar o overlay**

```tsx
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ServiceRow } from "../../core/state/reconcile";
import { Overlay } from "../components/Overlay";
import { isMouseInput } from "../mouse/parse";
import { theme } from "../theme";

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
}) {
	const [showResult, setShowResult] = useState(false);
	const record = row.record;

	useInput((input, key) => {
		if (isMouseInput(input)) return;
		if (key.escape) {
			if (showResult) setShowResult(false);
			else onClose();
			return;
		}
		if (busy) return; // uma operação por vez
		if (input === "i") onControl("start");
		if (input === "p") onControl("stop");
		if (input === "t") onControl("restart");
		if (input === "r") onRun();
		if (input === "e") onEdit();
		if (input === "b") onSwitchBackend();
		if (input === "l") onLogs();
		if (input === "x") onRemove();
		if (input === "v") setShowResult(true);
	});

	if (showResult && record)
		return (
			<Overlay title={`resultado · ${row.name}`} columns={columns} rows={rows}>
				{record.lastRun?.status === "error" ? (
					<Text color={theme.error}>{record.lastRun.error ?? "sem detalhe"}</Text>
				) : (
					formatStats(record).map((line) => <Text key={line}>{line}</Text>)
				)}
			</Overlay>
		);

	return (
		<Overlay
			title={row.name}
			columns={columns}
			rows={rows}
			footer={
				busy ? <Text color={theme.warn}>{busy}</Text> : undefined
			}
		>
			<Text color={theme.muted}>
				{record
					? `${record.mode} · ${record.config} · ${record.backend}`
					: "sem registro — adotado do supervisor"}
			</Text>
			<Text> </Text>
			{record?.lastRun?.status === "error" ? (
				<Text color={theme.error}>
					✗ última execução falhou — v mostra o erro
				</Text>
			) : record?.lastRun?.status === "ok" ? (
				<Text color={theme.ok}>✓ concluído — v mostra o resultado</Text>
			) : null}
			<Text> </Text>
			<Action tecla="i" label="iniciar" />
			<Action tecla="p" label="parar" />
			<Action tecla="t" label="reiniciar" />
			<Action tecla="r" label="rodar agora aqui (1º plano, ao vivo)" />
			<Action tecla="b" label="trocar modo de inicialização" />
			<Action tecla="l" label="logs" />
			<Action tecla="e" label="editar" />
			<Action tecla="x" label="remover" />
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
```

- [ ] **Step 3: Verificar tipos**

Run: `bunx tsc --noEmit`
Expected: sem erro.

- [ ] **Step 4: Commitar**

```bash
bunx biome check --write src test
git add src/tui/screens/ServiceDetail.tsx
git commit -m "feat(tui): overlay de detalhe com as ações do serviço"
```

---

### Task 13: Formulário único

**Files:**
- Create: `src/tui/screens/ServiceForm.tsx`
- Test: manual + reuso dos testes de `tuiConfig.test.ts`

**Interfaces:**
- Consumes: `FormState`, `buildConfig`, `writeConfig`, `validateConfig` de `src/core/config/`; `useInspector`; `CollectionPicker`; `EntryPicker`; `SearchField`; `TextInput`; `Select`; `detectBackends`, `preferredBackend`; `Overlay`
- Produces:
  - `<ServiceForm dir initial?={ServiceRecord} columns rows onCancel onSubmit={(draft: ServiceDraft, andStart: boolean) => void} />`
  - `type ServiceDraft = { name: string; mode: RunMode; configPath: string; form: FormState; backend: Backend; boot: boolean }`

- [ ] **Step 1: Definir os campos**

O form é uma lista de campos navegável por `↑↓`, cada um com um editor próprio ativado por `enter`. Os campos, em ordem:

| Campo | Editor | Condição |
|---|---|---|
| `nome` | `TextInput` | sempre |
| `modo` | `Select` (sync/migrate/ttl) | sempre |
| `config` | `Select` dos ymls achados + `— definir aqui —` | sempre |
| `origem.uri` | `TextInput` (conecta ao sair) | só com `— definir aqui —` |
| `origem.db` | `Select` dos bancos | idem, e só conectado |
| `destino.uri` | `TextInput` | idem |
| `destino.db` | `Select` | idem |
| `collections` | `CollectionPicker` | idem |
| `views` | `EntryPicker` | idem, e só `sync` |
| `índices` | `EntryPicker` | idem, e só `sync` |
| `backend` | `Select` dos disponíveis | sempre |
| `boot` | toggle | sempre |

- [ ] **Step 2: Implementar o esqueleto navegável**

```tsx
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { Overlay } from "../components/Overlay";
import { isMouseInput } from "../mouse/parse";
import { theme } from "../theme";

type FieldId =
	| "name" | "mode" | "config"
	| "sourceUri" | "sourceDb" | "destUri" | "destDb"
	| "collections" | "views" | "indexes"
	| "backend" | "boot";

/**
 * Um formulário só, tudo à vista.
 *
 * O passo a passo era o atrito principal: para trocar o destino de um yml
 * existente era preciso atravessar modo → origem → destino, e para conferir uma
 * escolha feita três passos atrás, voltar e perder o lugar. Aqui todo campo é
 * alcançável com uma seta ou um clique, na ordem que a pessoa quiser.
 *
 * Campo que depende de conexão fica APAGADO com o motivo ao lado, nunca some:
 * campo que desaparece é indistinguível de campo que não existe.
 */
export function ServiceForm(/* props conforme a interface acima */) {
	const [cursor, setCursor] = useState(0);
	const [editing, setEditing] = useState<FieldId | null>(null);

	const fields = useMemo(() => visibleFields(draft), [draft]);

	useInput((input, key) => {
		if (isMouseInput(input)) return;
		if (editing) return; // o editor do campo é quem escuta
		if (key.escape) return onCancel();
		if (key.upArrow) setCursor(Math.max(0, cursor - 1));
		if (key.downArrow) setCursor(Math.min(fields.length - 1, cursor + 1));
		if (key.return) setEditing(fields[cursor]?.id ?? null);
		if (key.ctrl && input === "s") onSubmit(draft, true);
		if (key.ctrl && input === "o") onSubmit(draft, false);
	});

	// … render de cada campo, com o editor inline quando `editing === field.id`
}
```

Implemente `visibleFields(draft)` devolvendo apenas os campos aplicáveis (a tabela do Step 1), e o render de cada linha como `rótulo … valor`, usando o componente `Stat` do `Shell` para o alinhamento.

- [ ] **Step 3: Ligar a conexão da origem**

Reaproveite `useInspector` (já existe e faz exatamente isso). Ao sair do campo `sourceUri`, chame o connect; enquanto `state !== "connected"`, os campos `sourceDb`, `collections`, `views` e `indexes` renderizam assim:

```tsx
<Text color={theme.muted}>
	{"  collections "}
	<Text color={theme.border}>… informe a origem para listar</Text>
</Text>
```

E permaneçam **selecionáveis**: entrar neles com `enter` abre um `TextInput` para digitar os nomes à mão, separados por vírgula. Sem conexão ainda dá para criar o serviço.

- [ ] **Step 4: Avisar sobre o sudo ao marcar `boot`**

No render do campo `boot`, quando marcado:

```tsx
{needsSudo(draft.backend) ? (
	<Text color={theme.warn}> ⚠ vai precisar de sudo (1 comando)</Text>
) : null}
```

com

```ts
/** Os três únicos passos privilegiados do projeto, todos sobre boot. */
function needsSudo(backend: Backend): boolean {
	return backend === "docker" || backend === "pm2" || backend === "systemd";
}
```

O aviso é conservador de propósito: o `systemd` normalmente resolve o linger sem sudo, mas prometer "não vai precisar" e depois precisar é pior do que avisar à toa.

- [ ] **Step 5: Backend indisponível mostra motivo e conserto**

No `Select` de backend, itens vindos de `detectBackends(dir)`:

```tsx
{availability.map((a) => (
	<Text key={a.backend} color={a.available ? theme.label : theme.muted}>
		{a.available ? "  " : "✗ "}
		{a.backend}
		{a.reason ? <Text color={theme.muted}>{`  ${a.reason}`}</Text> : null}
		{a.fix ? <Text color={theme.warn}>{`  → ${a.fix}`}</Text> : null}
	</Text>
))}
```

`reason` e `fix` já vêm prontos de `detect.ts` e hoje são descartados.

- [ ] **Step 6: Gravar**

Ao submeter, na ordem: `validateConfig(mode, buildConfig(form))` → se houver erros, mostrá-los no rodapé do overlay e **não** gravar; senão `writeConfig`, depois `writeRecord`, depois (se `andStart`) `buildPlan` + `installService`.

- [ ] **Step 7: Verificar tipos e commitar**

```bash
bunx tsc --noEmit && bun test
bunx biome check --write src test
git add src/tui/screens/ServiceForm.tsx
git commit -m "feat(tui): formulário único de criação e edição de serviço"
```

---

### Task 14: Log em tela cheia

**Files:**
- Create: `src/tui/screens/LogViewer.tsx`
- Test: `test/tuiKeys.test.ts` (a lógica de janela é pura)

**Interfaces:**
- Consumes: `logWindow`, `filterLines`, `tailFile`, `listLogFiles` de `src/core/logs/readLog.ts`; `tailCommand`; `copyToClipboard`; `hintsFor("logs")`
- Produces:
  - `<LogViewer row columns rows onClose />`
  - `scrollWindow(total: number, height: number, offset: number): { start: number; end: number }`

- [ ] **Step 1: Escrever o teste da janela de rolagem**

Acrescentar a `test/tuiKeys.test.ts`:

```ts
import { scrollWindow } from "../src/tui/screens/LogViewer";

describe("scrollWindow", () => {
	test("offset 0 mostra o FIM do log (é o que interessa)", () => {
		expect(scrollWindow(1000, 40, 0)).toEqual({ start: 960, end: 1000 });
	});

	test("rolar para cima anda para trás", () => {
		expect(scrollWindow(1000, 40, 10)).toEqual({ start: 950, end: 990 });
	});

	test("não passa do começo do arquivo", () => {
		expect(scrollWindow(1000, 40, 5000)).toEqual({ start: 0, end: 40 });
	});

	test("log menor que a tela mostra tudo", () => {
		expect(scrollWindow(10, 40, 0)).toEqual({ start: 0, end: 10 });
	});
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test test/tuiKeys.test.ts`
Expected: FAIL — `LogViewer` não existe.

- [ ] **Step 3: Implementar `scrollWindow`**

Em `src/tui/screens/LogViewer.tsx`:

```ts
/**
 * Qual fatia do buffer aparece na tela.
 *
 * `offset` conta linhas ACIMA do fim, não do começo: um log ao vivo cresce, e
 * ancorar no começo faria a janela deslizar sozinha enquanto a pessoa lê.
 */
export function scrollWindow(
	total: number,
	height: number,
	offset: number,
): { start: number; end: number } {
	const end = Math.max(Math.min(total, height), total - offset);
	return { start: Math.max(0, end - height), end };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test test/tuiKeys.test.ts`
Expected: PASS.

- [ ] **Step 5: Implementar o visualizador**

O componente ocupa a tela inteira (não usa `Overlay`, não usa `Shell`): `<Box flexDirection="column" width={columns} height={rows}>` com uma linha de título, o corpo e a barra de teclas de `hintsFor("logs")`.

Estado: `lines: string[]`, `offset: number`, `follow: boolean`, `query: string | null`, `matches: number[]`, `cursorLine: number`.

Teclado, conforme `KEYS.logs`:

```tsx
useInput((input, key) => {
	if (isMouseInput(input)) return;
	if (key.escape) return onClose();
	if (key.upArrow) { setFollow(false); setOffset((o) => o + 1); }
	if (key.downArrow) setOffset((o) => Math.max(0, o - 1));
	if (key.pageUp) { setFollow(false); setOffset((o) => o + bodyHeight); }
	if (key.pageDown) setOffset((o) => Math.max(0, o - bodyHeight));
	if (input === "g") { setFollow(false); setOffset(lines.length); }
	if (input === "G") { setOffset(0); }
	if (input === "f") setFollow((f) => !f);
	if (input === "/") setSearching(true);
	if (input === "n") jumpToMatch(+1);
	if (input === "N") jumpToMatch(-1);
	if (input === "Y") copyToClipboard(visibleLines.join("\n"));
});
```

Duas regras que valem a pena não perder:

- **Rolar para cima desliga o `follow` sozinho.** Ler o passado enquanto a tela pula para o fim a cada linha nova é impossível.
- **`G` volta ao fim e religa o `follow`.** É o gesto de "voltar a acompanhar".

Para o conteúdo ao vivo, use `tailCommand(backend, name, workingDir)` e alimente um `LineBuffer` (já existe em `core/run/logLines.ts`); para o gravado, `tailFile` + `listLogFiles`.

- [ ] **Step 6: Verificação manual no tmux**

```bash
tmux kill-session -t lv 2>/dev/null
tmux new-session -d -s lv -x 120 -y 40 -c "$PWD" "bun run src/cli.ts tui"
sleep 4
# navegue até um serviço e aperte l
tmux send-keys -t lv l; sleep 2; tmux capture-pane -p -t lv | head -5
tmux kill-session -t lv
```

Expected: o log ocupa a largura e a altura inteiras, sem sidebar nem painel de contexto.

- [ ] **Step 7: Commitar**

```bash
bunx biome check --write src test
git add src/tui/screens/LogViewer.tsx test/tuiKeys.test.ts
git commit -m "feat(tui): log em tela cheia com rolagem, busca e cópia"
```

---

### Task 15: Amarrar tudo e remover o que saiu

**Files:**
- Modify: `src/tui/App.tsx`, `CLAUDE.md`, `docs/superpowers/specs/2026-08-15-tui-service-panel-design.md`
- Delete: `src/tui/screens/Home.tsx`, `src/tui/screens/Services.tsx`, `src/tui/screens/Running.tsx`, `src/tui/screens/Wizard.tsx`, `src/tui/screens/wizard/`, `src/tui/hooks/useBackgroundStart.ts`

**Interfaces:**
- Consumes: tudo das Tasks 1-14
- Produces: `<App dir={string} />` com uma tela raiz e uma pilha de camadas

- [ ] **Step 1: Reescrever o `App.tsx`**

```tsx
type Layer =
	| { name: "detail"; row: ServiceRow }
	| { name: "form"; initial?: ServiceRecord }
	| { name: "logs"; row: ServiceRow }
	| { name: "help" }
	| { name: "runner"; row: ServiceRow };

export function App({ dir }: { dir: string }) {
	const [stack, setStack] = useState<Layer[]>([]);
	const [reloadKey, setReloadKey] = useState(0);
	const [cursor, setCursor] = useState(0);
	const { rows, loading } = useServiceRows(reloadKey);
	const { exit } = useApp();

	const top = stack.at(-1) ?? null;
	const layer: KeyLayer = top?.name === "logs" ? "logs"
		: top?.name === "form" ? "form"
		: top?.name === "detail" ? "detail"
		: "list";

	const push = (l: Layer) => setStack((s) => [...s, l]);
	const pop = () => setStack((s) => s.slice(0, -1));

	useInput((input, key) => {
		if (key.ctrl && input === "d") exit();
		// `?` abre a ajuda DA CAMADA ATUAL; esc fecha só a ajuda.
		if (input === "?" && top?.name !== "help") push({ name: "help" });
	});

	// … render: Shell com a lista como children e o overlay da camada de cima
}
```

Regras a manter no render:

- A lista **nunca desmonta** — é o que preserva o cursor ao fechar um overlay.
- `enabled={stack.length === 0}` na lista; cada overlay recebe `enabled` só quando é o topo.
- `hints={hintsFor(layer)}` — a barra segue a camada.
- Logs em tela cheia **não** passam pelo `Shell` (ocupam tudo); as demais camadas passam.

- [ ] **Step 2: Rodar a TUI e percorrer o fluxo inteiro**

```bash
tmux kill-session -t pul 2>/dev/null
tmux new-session -d -s pul -x 140 -y 45 -c "$PWD" "bun run src/cli.ts tui"
sleep 4; tmux capture-pane -p -t pul
```

Roteiro (capture a tela depois de cada passo):

1. `?` abre a ajuda da lista; `esc` fecha e o cursor continua onde estava.
2. `n` abre o formulário; preencher nome, modo `ttl`, escolher `configs/ttl-example.yml`, backend `systemd`, boot ligado — conferir que aparece o aviso de sudo.
3. `ctrl+s` cria: conferir que a senha é pedida no terminal (ou que roda direto, se o sudo for sem senha) e que **o terminal volta com eco**.
4. O serviço aparece na lista; `enter` abre o detalhe; `l` abre o log em tela cheia; `↑` rola e desliga o follow; `G` volta ao fim.
5. `esc` até a lista, `enter` no serviço, `x` remove.
6. `q` sai e o terminal fica limpo (sem sujar o scrollback).

```bash
tmux kill-session -t pul
```

- [ ] **Step 3: Remover as telas antigas**

```bash
git rm src/tui/screens/Home.tsx src/tui/screens/Services.tsx \
       src/tui/screens/Running.tsx src/tui/screens/Wizard.tsx \
       src/tui/hooks/useBackgroundStart.ts
git rm -r src/tui/screens/wizard
bunx tsc --noEmit
```

Expected: nenhum erro. Se algum import ficar órfão, remova-o. Se um sub-componente do wizard (`CollectionPicker`, `EntryPicker`) ainda for usado pelo `ServiceForm`, **não** o remova — ele vive em `src/tui/components/`, não em `screens/wizard/`.

- [ ] **Step 4: Rodar a suíte inteira**

Run: `bun run test:up && bun test`
Expected: tudo passando. Os testes de Mongo (`engine.*`, `sync*`) precisam dos containers; os deste plano não.

- [ ] **Step 5: Atualizar a documentação**

Em `CLAUDE.md`, substituir a seção `## TUI (pulsar sem argumento)` inteira por uma descrição do painel de serviços: tela raiz única, os quatro overlays, o registro em `~/.pulsar`, o sudo resolvido na criação, o one-shot que desliga o boot, e o `?`. Remova as menções a `Home`, `Services`, `Running`, wizard e ao atalho `b`. Atualize também a árvore de `src/tui/` e acrescente `src/core/state/` e `src/core/tty/` à árvore de `src/core/`.

Na spec, trocar `Status: desenhado (não implementado)` por `Status: implementado`.

- [ ] **Step 6: Commitar**

```bash
bunx biome check --write src test
git add -A
git commit -m "feat(tui): painel único de serviços substitui as telas antigas"
```

---

## Auto-revisão

**Cobertura da spec:**

| Requisito da spec | Task |
|---|---|
| Lista raiz + 4 overlays | 1, 11, 12, 13, 14 |
| `tab` deixa de trocar foco | 11 (prop `enabled`), 15 |
| `overlay()` em `layout.ts` | 1 |
| Registro `~/.pulsar/services/*.json` | 3 |
| Registro corrompido não derruba a lista | 3 |
| `runRecord` gravado pelo próprio processo | 4 |
| Reconciliação, 4 casos | 6 |
| Adotar do supervisor | 5 |
| Formulário único, campos apagados com motivo | 13 |
| Serviço sempre aponta para um yml | 13 (Step 6) |
| Backend indisponível com motivo e conserto | 13 (Step 5) |
| Sudo: aviso ao marcar boot | 13 (Step 4) |
| Sudo: preflight `sudo -n` | 7 |
| Sudo: entrega do TTY | 2, 7 |
| Pular sudo não falha a instalação | 7 |
| One-shot desliga o boot | 8 |
| Trocar backend com rollback | 9 |
| Logs em tela cheia | 14 |
| Ajuda `?` contextual, fonte única | 10 |
| Erros como estado no item | 12 (`formatStats`, `v`) |
| Remoções | 15 |

**Lacuna conhecida:** a spec cita `pm2 startup` como passo privilegiado, mas ele não é um comando `sudo` — ele *imprime* um comando com sudo. Na Task 7 ele cai no caminho `needs-password` e o usuário verá o comando literal, o que é o comportamento certo; a saída impressa aparece no streaming do passo. Não requer task extra, mas vale conferir na verificação manual da Task 15 se o texto impresso fica legível no overlay.

**Consistência de tipos:** `ServiceRecord` (Task 3) é consumido por 4, 5, 6, 8, 9, 12, 13; `ServiceRow` (Task 6) por 11, 12, 14; `SudoMode`/`AskCallback` (Task 7) por 8, 9, 13. `installService` muda de assinatura na Task 7 e é chamado depois em 9 e 13 já com o novo formato.
