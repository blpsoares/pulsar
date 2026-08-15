import { describe, expect, test } from "bun:test";
import { DISABLE_MOUSE, ENTER_ALT, LEAVE_ALT } from "../src/core/tty/ansi";
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
