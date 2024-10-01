#!/usr/bin/env bun

import { showTitle } from './utils/show-cli-title';
import { Command } from 'commander';
import dumpDbFn from './cli/dump';

await showTitle();

const program = new Command();

program.version('1.0.0').description('Mongo pulsar cli to sync data');

program
  .command('dump <file>')
  .option(
    '-p --parallel <number>',
    'send a number to export collections in parallel, example: -p 2 or --parallel 2.\nBy default this value is 3.',
  )
  .action(dumpDbFn);

program.parse(process.argv);
