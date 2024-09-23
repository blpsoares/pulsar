import { conn } from './db/conn';
import { showTitle } from './utils/show-cli-title';

await showTitle();
const client = await conn();
