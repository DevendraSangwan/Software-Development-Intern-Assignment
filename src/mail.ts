import nodemailer from "nodemailer";
import { config } from "./config";

export const mailTransport = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  auth: config.SMTP_USER && config.SMTP_PASS
    ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
    : undefined
});

export async function sendEmail(input: {
  senderName: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  textBody: string;
  emailId: string;
}) {
  if (!config.SMTP_USER || !config.SMTP_PASS) {
    throw new Error("SMTP_USER and SMTP_PASS must be configured before sending email.");
  }
  return mailTransport.sendMail({
    from: { name: input.senderName, address: input.senderEmail },
    to: input.recipient,
    subject: input.subject,
    text: input.textBody,
    headers: { "X-Scheduler-Email-ID": input.emailId }
  });
}
