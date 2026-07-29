import { spawnSync } from "node:child_process";

/**
 * Copiar para a área de transferência de dentro de uma TUI.
 *
 * A ordem importa. Primeiro OSC 52: é uma sequência de escape que pede ao
 * TERMINAL para copiar, então funciona **através de SSH** e dentro de container
 * — justamente onde o pulsar roda. Utilitário local (`pbcopy`, `wl-copy`,
 * `xclip`) copiaria para a área de transferência da máquina remota, que não é a
 * do usuário.
 *
 * Nem todo terminal tem OSC 52 habilitado (o tmux exige `set -g set-clipboard
 * on`), por isso os utilitários locais entram como reforço: mandar os dois é
 * inofensivo e cobre os dois cenários.
 */

export type CopyResult = { ok: boolean; via: "osc52" | "comando" | "nenhum" };

export function copyToClipboard(text: string): CopyResult {
	const osc = writeOsc52(text);
	const local = writeWithCommand(text);

	if (local) return { ok: true, via: "comando" };
	if (osc) return { ok: true, via: "osc52" };
	return { ok: false, via: "nenhum" };
}

/**
 * OSC 52: `ESC ] 52 ; c ; <base64> BEL`.
 *
 * Terminais costumam recusar payloads gigantes (o limite varia; ~100KB é o teto
 * comum). Cortamos antes para não emitir uma sequência que o terminal
 * descartaria pela metade — copiar meio texto seria pior que não copiar.
 */
const OSC52_MAX_BYTES = 74_000;

function writeOsc52(text: string): boolean {
	if (!process.stdout.isTTY) return false;

	const payload = Buffer.from(text, "utf8");
	if (payload.byteLength > OSC52_MAX_BYTES) return false;

	try {
		process.stdout.write(`\x1b]52;c;${payload.toString("base64")}\x07`);
		return true;
	} catch {
		return false;
	}
}

function writeWithCommand(text: string): boolean {
	const candidates: [string, string[]][] = [
		["pbcopy", []], // macOS
		["wl-copy", []], // Wayland
		["xclip", ["-selection", "clipboard"]],
		["xsel", ["--clipboard", "--input"]],
	];

	for (const [cmd, args] of candidates) {
		try {
			const result = spawnSync(cmd, args, { input: text, timeout: 2000 });
			// `error` preenchido = binário ausente; segue para o próximo.
			if (!result.error && result.status === 0) return true;
		} catch {
			// idem
		}
	}
	return false;
}

/** Descrição curta do que foi copiado, para a mensagem na tela. */
export function describeCopy(text: string, max = 46): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
