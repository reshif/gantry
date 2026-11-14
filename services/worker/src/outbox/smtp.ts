import nodemailer from "nodemailer";
import { PermanentError, TransientError } from "../errors.js";

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Stable per (event, destination): a duplicate delivery after a crash carries the same Message-ID. */
  messageId: string;
  /** The connection's own From address; the platform default when absent. */
  from?: string;
  headers?: Record<string, string>;
}

export interface Mailer {
  send(m: MailMessage): Promise<void>;
}

/** SMTP via nodemailer to SMTP_HOST (mailpit locally). Connection trouble is transient, a refused recipient is permanent. */
export function smtpMailer(o: { host: string; port: number; from: string; secure: boolean; auth?: { user: string; pass: string } }): Mailer {
  const t = nodemailer.createTransport({ host: o.host, port: o.port, secure: o.secure, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, tls: { rejectUnauthorized: true }, ...(o.auth ? { auth: o.auth } : {}) });
  return {
    async send(m) {
      try {
        await t.sendMail({ from: m.from ?? o.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), messageId: m.messageId, ...(m.headers ? { headers: m.headers } : {}) });
      } catch (e) {
        const code = (e as { responseCode?: number }).responseCode;
        if (code !== undefined && code >= 500 && code < 600) throw new PermanentError(`SMTP refused the message: ${(e as Error).message}`, "smtp_refused");
        throw new TransientError(`SMTP delivery failed: ${(e as Error).message}`, "smtp");
      }
    },
  };
}
