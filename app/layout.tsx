import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sudachi Lookup",
  description: "Fast, private, in-browser lookup for the Sudachi Japanese lexicon.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
