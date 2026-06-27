import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tradecraft Bot Lab",
  description: "51 automated trading bots competing in real-time. Powered by Claude AI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
