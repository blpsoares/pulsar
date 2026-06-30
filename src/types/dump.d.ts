type MongoStatusReturn = {
	success: string | false;
	failed: string | false;
	// Collection que não existe na origem: não é falha retentável, é pulada.
	missing?: string | false;
};
