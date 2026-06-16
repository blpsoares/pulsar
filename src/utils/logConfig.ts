export type LogConfig = {
	verbose: boolean;
	progress: boolean;
};

let config: LogConfig = { verbose: false, progress: true };

export const setLogConfig = (cfg: Partial<LogConfig>) => {
	config = { ...config, ...cfg };
};

export const getLogConfig = (): LogConfig => config;
