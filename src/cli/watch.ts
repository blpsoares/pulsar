import { Db } from "mongodb";
import { conn } from "../db/conn";
import path from "path";
import { existsSync, mkdirSync } from "fs";
import parseYml from "../utils/parseYml";

export async function watchCollections(ymlpath: string){
  const outputExport = path.resolve(__dirname, '..', '..', 'temp-dump');

  if (!existsSync(outputExport)) mkdirSync(outputExport);

  const options = parseYml<>(ymlpath);
  const client =  await conn('mongodb+srv://u1-prod-escrita:REDACTED@elmd-aurora-01.9txz8.mongodb.net');
  const db = client.db('aurora');
  const collections = (await db.listCollections().toArray()).map((collection) => collection.name);
}

// watchCollections();