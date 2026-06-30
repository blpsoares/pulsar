import en from "../i18n/en";
import pt from "../i18n/pt";

export type Lang = "en" | "pt";

const dicts = { en, pt } as const;
let cur: Lang = "en";

export function setLang(l: string | undefined | null): void {
	if (l === "en" || l === "pt") cur = l;
}

export function getLang(): Lang {
	return cur;
}

export function t(key: string, params?: Record<string, unknown>): string {
	const d = dicts[cur] as Record<string, string>;
	const fallback = en as Record<string, string>;
	const s = d[key] ?? fallback[key] ?? key;
	return String(s).replace(/\{(\w+)\}/g, (_, p) =>
		params && params[p] != null ? String(params[p]) : "",
	);
}
