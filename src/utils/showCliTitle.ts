import chalk from "chalk";
import figlet from "figlet";
import { t } from "./i18n";

export const showTitle = () => {
	return new Promise((resolve) => {
		figlet(
			"P U L S A R",
			{ font: "Rectangles", verticalLayout: "controlled smushing" },
			(err, title) => {
				if (err) {
					console.log(t("cli.title.fallback"));
				} else {
					console.log(chalk.italic.hex("#9b00ff").bold(title).concat(`\n\n`));
				}
				resolve(true);
			},
		);
	});
};
