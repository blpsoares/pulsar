// TODO:
//? Bring messages from collections that were not dumped/restored to this file (making the dump and restore functions cleaner)
export const MongoStatusReturns = (
	collectionsStats: MongoStatusReturn[],
	message?: string,
): string[][] => {
	const successfulExports: string[] = [];
	const failedExports: string[] = [];
	collectionsStats.forEach((item) => {
		if (item.success) successfulExports.push(item.success);
		if (item.failed) failedExports.push(item.failed);
	});

	return [successfulExports, failedExports];
};
