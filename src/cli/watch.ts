import { conn } from "../db/conn";

export async function watchCollections(){
  const client =  await conn('mongodb://localhost:27017/aurora');
}
