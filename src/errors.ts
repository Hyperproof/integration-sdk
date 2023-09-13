export enum ErrorName {
  REFRESH_TOKEN_ATTEMPTS_EXHAUSTED = 'attemptsExhausted',
  REFRESH_TOKEN_ATTEMP_FAILED = 'attemptFailed'
}

export class RefreshTokenError extends Error {
  name: ErrorName;
  message: string;

  constructor({ name, message }: { name: ErrorName; message: string }) {
    super();
    this.name = name;
    this.message = message;
  }
}
