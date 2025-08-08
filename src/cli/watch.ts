import { conn } from "../db/conn";
import parseYml from "../utils/parseYml";
import { errorHandler } from "../errors/errorHandler";
import type { Db } from "mongodb";

export async function getCollections(
  db: Db,
  cliParams: WatchOptionsCli,
  options: WatchYmlOptions,
  ymlpath: string
) {
  let collections: string[] = [];
    if(cliParams.all){
      collections = (await db.listCollections().toArray()).map((collection) => collection.name);
    } else if (options.command.watch.collections){
      collections = options.command.watch.collections;
    } else {
      throw errorHandler(new Error(`No collections to watch on file: ${ymlpath}`))
    }
    return collections;
}

export async function watchCollections(ymlpath: string, cliParams: WatchOptionsCli){
  const options = parseYml<WatchYmlOptions>(ymlpath);
  const client =  await conn(options.command.watch.source.uri, 'source');
  const db = client.db('aurora');
  try {
    const collections = await getCollections(db, cliParams, options, ymlpath);
    console.log(collections);
  } catch (error) {

  } finally {
    client.close();
  }
}

