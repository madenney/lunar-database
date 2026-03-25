import nodemailer, { Transporter } from "nodemailer";
import { config } from "../config";

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: config.alertEmailFrom,
      pass: config.gmailAppPassword,
    },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });

  return transporter;
}

export async function sendAlertEmail(subject: string, body: string): Promise<void> {
  if (!config.gmailAppPassword || !config.alertEmailTo) {
    console.warn("[ALERT] Email not configured, logging instead:", subject);
    console.warn(body);
    return;
  }

  const tx = getTransporter();
  await tx.sendMail({
    from: `"Lunar Melee API" <${config.alertEmailFrom}>`,
    to: config.alertEmailTo,
    subject: `[LM Alert] ${subject}`,
    text: body,
  });
}
