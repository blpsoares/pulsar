/**
 * Relatório de tempo da CARGA INICIAL (dump do sync / migrate): uma linha única
 * e greppável dizendo quantas collections foram carregadas e quanto tempo levou
 * do início da 1ª até o fim da última — pra reportar "banco up em X".
 */

import { t } from "./i18n";

/** Duração decorrida formatada: "45s" / "1m 30s" / "1h 5m 03s". */
export function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	if (h > 0) return `${h}h ${m}m ${pad(s)}s`;
	if (m > 0) return `${m}m ${pad(s)}s`;
	return `${s}s`;
}

/** Hora local HH:MM:SS a partir de epoch ms. */
function clock(epochMs: number): string {
	const d = new Date(epochMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Linha única da carga inicial: nº de collections + início/fim (relógio) + total. */
export function formatLoadReport(
	count: number,
	startEpochMs: number,
	endEpochMs: number,
): string {
	return t("load.report", {
		count,
		start: clock(startEpochMs),
		end: clock(endEpochMs),
		total: formatDuration(endEpochMs - startEpochMs),
	});
}
