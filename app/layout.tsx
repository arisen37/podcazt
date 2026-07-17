import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Podcazt",
  description: "Record podcasts and solo episodes from the browser."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="navWrap">
          <div className="shell">
            <nav className="nav">
              <Link className="brand" href="/">
                Podcazt<span className="brandDot">.</span>
              </Link>
              <div className="btnRow">
                <Link className="btn btnPrimary" href="/signin">Try for free</Link>
              </div>
            </nav>
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
