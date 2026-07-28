/**
 * Esconde a senha de uma connection string para exibição.
 *
 * A TUI mostra URIs em várias telas (lista de configs, cabeçalho do wizard,
 * painel do serviço). Uma delas quase certamente vai parar num screenshot ou
 * numa gravação de tela — a senha do Atlas não pode ir junto.
 *
 * Só afeta exibição: o valor gravado no yml continua íntegro.
 */
export function maskUri(uri: string): string {
	if (!uri) return "";
	// mongodb://user:senha@host/... -> mongodb://user:•••@host/...
	return uri.replace(
		/^(mongodb(?:\+srv)?:\/\/)([^:/@]+):([^@]+)@/i,
		(_m, scheme, user) => `${scheme}${user}:•••@`,
	);
}

/** Encurta a URI para caber numa coluna, preservando o host (o que identifica). */
export function shortUri(uri: string, max = 48): string {
	const masked = maskUri(uri);
	if (masked.length <= max) return masked;
	return `${masked.slice(0, max - 1)}…`;
}
