import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ventry",
  description: "Ventry backend — sign-in, models, and device auth for the Ventry desktop agent",
  icons: [{ rel: "icon", url: "/entry.svg", type: "image/svg+xml" }],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
