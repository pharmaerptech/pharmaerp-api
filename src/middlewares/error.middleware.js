import logger from "../config/logger.js";

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;

  // log error
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`);
  if (err.stack) {
    logger.error(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    statusCode,
    message: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

export default errorHandler;
