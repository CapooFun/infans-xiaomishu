export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

export function publicError(error) {
  if (error instanceof VaultError) {
    return { code: error.code, message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "The read-only Vault request failed." };
}
