import { t } from "../../utils/i18n";

const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	sec: 1,
	seconds: 1,
	min: 60,
	minutes: 60,
	h: 3600,
	hours: 3600,
	d: 86400,
	days: 86400,
	w: 604800,
	weeks: 604800,
	mo: 2592000, // 30 dias
	months: 2592000,
	y: 31536000, // 365 dias
	years: 31536000,
};

/**
 * Converte duração humana ("30d", "1h", "3mo") em segundos pro expireAfterSeconds.
 * Aceita também um número (já em segundos). 'm' sozinho é proibido por ser ambíguo
 * (minuto vs mês): use 'min' ou 'mo'. Mês = 30d, ano = 365d.
 */
export function parseDuration(input: string | number): number {
	if (typeof input === "number") {
		if (!Number.isFinite(input) || input <= 0) {
			throw new Error(t("ttl.duration.invalid_number", { input }));
		}
		return Math.floor(input);
	}

	const match = input
		.trim()
		.match(
			/^(\d+)(s|sec|seconds|min|minutes|h|hours|d|days|w|weeks|mo|months|y|years)$/,
		);
	if (!match) {
		throw new Error(t("ttl.duration.invalid_format", { input }));
	}

	const value = Number(match[1]);
	if (value <= 0) {
		throw new Error(t("ttl.duration.invalid_value", { input }));
	}
	return value * UNIT_SECONDS[match[2]];
}
