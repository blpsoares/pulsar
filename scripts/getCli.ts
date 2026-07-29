#!/usr/bin/env bun
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	statSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import chalk from "chalk";

/**
 * `bun run get:cli` — compila o pulsar e instala como comando do usuário.
 *
 * Existe porque o `bin:dev` fazia `cp ... ~/.local/bin` e pronto: se a pasta
 * não existisse, o cp falhava; se existisse mas estivesse fora do PATH, o
 * comando "não existia" sem nenhuma pista do porquê. Aqui os dois casos são
 * tratados e ditos em voz alta — instalar um binário que o shell não acha é
 * pior do que não instalar.
 *
 * Instala em ~/.local/bin (padrão XDG) sem sudo: nada é escrito fora da HOME.
 */

const BIN_NAME = "pulsar";
const TARGET_DIR =
	process.env.PULSAR_BIN_DIR ?? join(homedir(), ".local", "bin");
const BUILD_OUT = join(process.cwd(), "dist", BIN_NAME);

const ok = (msg: string) => console.log(`${chalk.green("✔")} ${msg}`);
const warn = (msg: string) => console.log(`${chalk.yellow("!")} ${msg}`);
const step = (msg: string) =>
	console.log(`${chalk.hex("#9b00ff")("▸")} ${msg}`);

step("compilando o binário…");
const build = Bun.spawnSync(
	["bun", "build", "--compile", "src/cli.ts", "--outfile", BUILD_OUT],
	{ stdout: "inherit", stderr: "inherit" },
);

if (build.exitCode !== 0) {
	console.error(`${chalk.red("✖")} a compilação falhou — nada foi instalado.`);
	process.exit(build.exitCode ?? 1);
}

mkdirSync(TARGET_DIR, { recursive: true });

const target = join(TARGET_DIR, BIN_NAME);
copyFileSync(BUILD_OUT, target);
// O bit de execução não sobrevive a todo sistema de arquivos (e a cópia por
// cima de um arquivo antigo pode herdar o modo dele).
chmodSync(target, 0o755);

ok(`instalado em ${chalk.bold(target)} (${mib(target)})`);

/**
 * Um binário fora do PATH é indistinguível de um binário não instalado. Se for
 * o caso, dizemos exatamente qual linha adicionar em qual arquivo.
 */
const inPath = (process.env.PATH ?? "")
	.split(delimiter)
	.some(
		(entry) => entry.replace(/\/+$/, "") === TARGET_DIR.replace(/\/+$/, ""),
	);

if (inPath) {
	ok(
		`${chalk.bold(BIN_NAME)} já está no PATH — rode ${chalk.bold(BIN_NAME)} para abrir a TUI.`,
	);
} else {
	warn(`${TARGET_DIR} não está no seu PATH. Adicione ao ${rcFile()}:`);
	console.log(`\n    export PATH="${TARGET_DIR}:$PATH"\n`);
	warn(
		`depois: ${chalk.bold(`source ${rcFile()}`)} (ou abra um terminal novo)`,
	);
}

function rcFile(): string {
	const shell = process.env.SHELL ?? "";
	if (shell.includes("zsh")) return "~/.zshrc";
	if (shell.includes("fish")) return "~/.config/fish/config.fish";
	// macOS abre login shell por padrão; o bash lê .bash_profile nesse caso.
	if (platform() === "darwin" && existsSync(join(homedir(), ".bash_profile")))
		return "~/.bash_profile";
	return "~/.bashrc";
}

function mib(path: string): string {
	return `${(statSync(path).size / 1024 / 1024).toFixed(0)} MB`;
}
