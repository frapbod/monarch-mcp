export class InputValidationError extends Error {
  override readonly name = 'InputValidationError';
}

export class AuthenticationError extends Error {
  override readonly name = 'AuthenticationError';
}

export class RequestCancelledError extends Error {
  override readonly name = 'RequestCancelledError';
}
