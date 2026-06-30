import cliprogress from "cli-progress";
import { t } from "./i18n";

export const createSingleBar = (
	start: number,
	progressMessage: string = t("progressbar.default_label"),
) => {
	const singleBar = new cliprogress.SingleBar({
		format: `⟬{bar}⟭ {percentage}% | {duration_formatted} | {value}/{total} | ${progressMessage}`,
		barCompleteChar: "※",
		barIncompleteChar: "⁍",
		emptyOnZero: true,
	});

	singleBar.start(start, 0);

	return singleBar;
};
