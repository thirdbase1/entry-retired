import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Entry Desktop",
  description: "Backend for the Entry desktop agent",
  icons: [{ rel: "icon", url: "/entry.svg", type: "image/svg+xml" }],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
