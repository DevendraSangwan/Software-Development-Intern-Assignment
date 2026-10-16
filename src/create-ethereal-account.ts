import nodemailer from "nodemailer";

async function main(): Promise<void> {
  const account = await nodemailer.createTestAccount();
  console.log("Ethereal test account created:");
  console.log(`SMTP_HOST=smtp.ethereal.email`);
  console.log(`SMTP_PORT=587`);
  console.log(`SMTP_USER=${account.user}`);
  console.log(`SMTP_PASS=${account.pass}`);
  console.log("Open https://ethereal.email/messages to inspect sent test messages.");
}

main().catch((error: unknown) => {
  console.error("Could not create an Ethereal test account:", error);
  process.exitCode = 1;
});
