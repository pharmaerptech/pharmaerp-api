import dotenv from "dotenv";

dotenv.config();

const env = {
  // app
  NODE_ENV: process.env.NODE_ENV || "development",

  PORT: Number(process.env.PORT) || 5001,

  APP_NAME: process.env.APP_NAME || "Pharmacy ERP Backend",

  API_PREFIX: process.env.API_PREFIX || "/api/v1",

  FRONTEND_URL:
    (process.env.FRONTEND_URL || "http://localhost:5173")
      .split(",")[0]
      .trim(),

  ALLOWED_FRONTEND_URLS: (process.env.FRONTEND_URL || "http://localhost:5173")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),

  // database
  DB_URI: process.env.DB_URI || "",

  // erp auth
  JWT_SECRET: process.env.JWT_SECRET || "",

  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "7d",

  // platform auth
  PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET || "",

  PLATFORM_JWT_EXPIRES_IN: process.env.PLATFORM_JWT_EXPIRES_IN || "7d",

  // cors
  CORS_ORIGIN: process.env.CORS_ORIGIN || "http://localhost:5173",

  // email (Brevo & Resend API Configuration)
  BREVO_API_KEY: process.env.BREVO_API_KEY || "",

  RESEND_API_KEY: process.env.RESEND_API_KEY || "",

  MAIL_FROM:
    (process.env.MAIL_FROM && process.env.MAIL_FROM.trim()) ||
    "Pharma ERP <devanshupadhyay2611@gmail.com>",
};

export default env;