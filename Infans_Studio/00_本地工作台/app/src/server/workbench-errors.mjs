export class WorkbenchWriteError extends Error {
  constructor(message, status = 400, code = "INVALID_WRITE") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
