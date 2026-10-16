import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Mitra Mail — Email Scheduler",
  description: "Schedule and monitor reliable email delivery."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
