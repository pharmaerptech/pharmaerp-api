// src/utils/sendEmail.js
import nodemailer from "nodemailer";
import brevoTransport from "nodemailer-brevo-transport";
import env from "../config/env.js";

const parseFromAddress = (fromStr) => {
  const raw = (fromStr || "").trim();
  if (!raw) return { name: "Pharma ERP", email: "devanshupadhyay2611@gmail.com" };
  const match = raw.match(/^(?:([^<]+)\s*<)?([^>]+)>?$/);
  if (match) {
    return {
      name: (match[1] || "").trim() || "Pharma ERP",
      email: (match[2] || "").trim(),
    };
  }
  return { name: "Pharma ERP", email: raw };
};

// Configure Nodemailer with Brevo API Transport to bypass port blocks
const createTransporter = () => {
  if (!env.BREVO_API_KEY) return null;
  try {
    return nodemailer.createTransport(
      new brevoTransport({
        apiKey: env.BREVO_API_KEY,
      }),
    );
  } catch (err) {
    console.error("[EMAIL] Failed to initialize brevoTransport:", err.message);
    return null;
  }
};

const transporter = createTransporter();

// Direct Brevo REST API delivery (bypasses any Nodemailer transport serialization quirks)
const sendViaBrevoDirectApi = async ({ to, subject, html, text }) => {
  const sender = parseFromAddress(env.MAIL_FROM);
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text || "",
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMsg = data?.message || data?.error || `Brevo HTTP ${response.status}`;
    throw new Error(errorMsg);
  }

  return {
    success: true,
    messageId: data?.messageId || "BREVO_REST_API",
  };
};

// Direct Resend REST API delivery
const sendViaResendApi = async ({ to, subject, html, text }) => {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  // Resend free tier without a custom verified domain requires 'onboarding@resend.dev'
  let sender = env.MAIL_FROM;
  if (!sender || sender.includes("gmail.com")) {
    sender = "Pharma ERP <onboarding@resend.dev>";
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: sender,
      to: [to],
      subject,
      html,
      text: text || "",
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMsg = data?.message || data?.error || `Resend HTTP ${response.status}`;
    throw new Error(errorMsg);
  }

  return {
    success: true,
    messageId: data?.id || "RESEND_REST_API",
  };
};

export const sendEmail = async ({ to, subject, html, text }) => {
  const mailOptions = {
    from: env.MAIL_FROM,
    to,
    subject,
    html,
    text: text || "",
  };

  const deliveryErrors = [];

  // 1. Attempt delivery via Nodemailer Brevo Transport
  if (env.BREVO_API_KEY && transporter) {
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`[BREVO SUCCESS] Email dispatched to: ${to} (MessageId: ${info?.messageId || "ok"})`);
      return {
        success: true,
        messageId: info?.messageId || "BREVO_API_DELIVERY",
      };
    } catch (nodemailerErr) {
      deliveryErrors.push(`Brevo Transport: ${nodemailerErr?.message}`);
      console.warn(
        "[EMAIL] Nodemailer Brevo transport failed, attempting Direct Brevo REST API fallback:",
        nodemailerErr?.message,
      );
    }
  }

  // 2. Direct Brevo REST API Fallback
  if (env.BREVO_API_KEY) {
    try {
      const directInfo = await sendViaBrevoDirectApi({ to, subject, html, text });
      console.log(`[BREVO DIRECT SUCCESS] Email dispatched to: ${to} via REST API`);
      return directInfo;
    } catch (directErr) {
      deliveryErrors.push(`Brevo API: ${directErr?.message}`);
      console.warn("[EMAIL] Brevo Direct REST API failed:", directErr?.message);
    }
  }

  // 3. Direct Resend Fallback
  if (env.RESEND_API_KEY) {
    try {
      console.log("[EMAIL] Attempting fallback delivery via Resend API...");
      const resendInfo = await sendViaResendApi({ to, subject, html, text });
      console.log(`[RESEND SUCCESS] Email dispatched to: ${to} via Resend API`);
      return resendInfo;
    } catch (resendErr) {
      deliveryErrors.push(`Resend: ${resendErr?.message}`);
      console.warn("[EMAIL] Resend delivery failed:", resendErr?.message);
    }
  }

  const combinedError =
    deliveryErrors.length > 0
      ? deliveryErrors.join(" | ")
      : "No email service configured (missing active BREVO_API_KEY or RESEND_API_KEY)";

  console.error("[EMAIL ERROR] All email delivery methods failed:", combinedError);
  throw new Error(combinedError);
};
