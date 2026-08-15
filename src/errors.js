class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

module.exports = { ApiError, sendError };
