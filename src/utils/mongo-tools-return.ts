// TODO:
//? Bring messages from collections that were not dumped/restored to this file (making the dump and restore functions cleaner)
export const mongoToolsReturns = (
  collectionsStats: MongoToolsReturn[],
  message?: string,
): string[][] => {
  const successfulExports: string[] = [];
  const failedExports: string[] = [];
  collectionsStats.forEach((item) => {
    if (item.sucess) successfulExports.push(item.sucess);
    if (item.failed) failedExports.push(item.failed);
  });

  return [successfulExports, failedExports];
};
