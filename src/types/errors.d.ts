class EnvironmentVariablesError extends Error {
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'EnvironmentVariablesError';
    this.cause = 'Environment variable is not declared or is empty';
    this.code = code;
  }
}

type ErrorObject = {
  message: string;
  breadcrumb: string | object;
  errorInstance: string;
};
