'use strict';
/**
 * src/utils/asyncHandler.js
 * Express 4 does not catch rejections from async handlers, so every async
 * controller is wrapped in this. A rejected promise is forwarded to next(err)
 * and lands in the central error handler — no unhandled rejections, no
 * duplicated try/catch in every controller.
 *
 *   router.post('/products', asyncHandler(productController.create));
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
module.exports = asyncHandler;
