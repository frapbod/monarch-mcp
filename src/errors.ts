export class InputValidationError extends Error {
  override readonly name = 'InputValidationError';
}

export class AuthenticationError extends Error {
  override readonly name = 'AuthenticationError';
}

export class RequestCancelledError extends Error {
  override readonly name = 'RequestCancelledError';

  constructor(
    message: string,
    readonly completedCount = 0,
    readonly change?: { readonly id: string; readonly reversible: boolean },
  ) {
    super(message);
  }
}
