#! /usr/bin/env bun

import { showTitle } from "./utils/showCliTitle";
import { Command } from "commander";
import migrateCollections from "./commands/dump";
import { watchCollections } from "./commands/watch";

await showTitle();

const program = new Command();

program.version("1.0.0").description("Mongo pulsar cli to sync data");

program
	.command("dump <file>")
	.option(
		"-p --parallel <number>",
		"send a number to export collections in parallel, example: -p 2 or --parallel 2.\nBy default this value is 2.",
	)
	.option(
		"-r --maxRetries <number>",
		"send a number to retry failed collections (exported and restored), example: -r 5 or --maxRetries 5.\nBy default this value is 3.",
	)
	.option("-a --all", "watch all collections")
	.action(migrateCollections);

program
	.command("watch <file>")
	.option("-a --all", "watch all collections")
	.action(watchCollections);

program.parse(process.argv);
