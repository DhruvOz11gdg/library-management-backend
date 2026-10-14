'use strict';
/**
 * src/utils/apiResponse.js
 * One response contract for every endpoint in this API:
 *
 *   success → { success: true,  message: "…", data: <payload> }
 *   failure → { success: false, message: "…", data: null, errors: [...] }
 *
 * The frontend's axios wrapper in `src/services/api.ts` unwraps `data`, so it
 * can rely on this shape never changing. `ApiError` lives here too — it is the
 * only thing the error handler needs to know about an error besides Mongoose's.
 */
/** Build the envelope. */
function apiResponse({ success = true, message = 'OK', data = null } = {}) {
  return { success, message, data };
}
/** Send a success envelope. */
function sendSuccess(res, { statusCode = 200, message = 'OK', data = null } = {}) {
  return res.status(statusCode).json(apiResponse({ success: true, message, data }));
}
/**
 * Operational (expected) error. Throw this anywhere in a controller/service and
 * the central error handler turns it into the failure envelope with this status.
 * Anything that is NOT an ApiError is treated as a bug and reported as a 500.
 */
class ApiError extends Error {
  constructor(statusCode, message, errors = []) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
  static badRequest(message = 'Bad request', errors = []) {
    return new ApiError(400, message, errors);
  }
  static unauthorized(message = 'Not authenticated') {
    return new ApiError(401, message);
  }
  static forbidden(message = 'Not allowed') {
    return new ApiError(403, message);
  }
  static notFound(message = 'Not found') {
    return new ApiError(404, message);
  }
  static conflict(message = 'Already exists') {
    return new ApiError(409, message);
  }
}
module.exports = { apiResponse, sendSuccess, ApiError };
