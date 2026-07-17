import Link from "next/link";

export default function Home() {
  return (
    <main className="shell hero">
      <section className="homeHero">
        <h1>
          Playground for
          <br />
          remote podcasts.
        </h1>
        <p className="homeEyebrow">
          Record <strong>studio-quality conversations</strong> from your browser.
        </p>
        <div className="btnRow homeActions">
          <Link className="btn btnPrimary" href="/signin">Try for free</Link>
        </div>
        <div className="homeMeta">
          <span>Free in early access</span>
          <span>No card required</span>
          <span>Private by default</span>
        </div>
        <div className="deviceGlow" aria-hidden="true">
          <div className="deviceScreen" />
        </div>
      </section>
    </main>
  );
}
