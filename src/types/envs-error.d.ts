class EnvironmentVariablesError extends Error {
  code?: string;
  readonly cause: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'EnvironmentVariablesError';
    this.cause = 'Environment variable is not declared or is empty';
    this.code = code;
  }
}
