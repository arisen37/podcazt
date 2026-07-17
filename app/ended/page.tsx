import Link from "next/link";

export default function EndedPage() {
  return (
    <main className="shell hero">
      <section>
        <p className="pill">Meeting ended</p>
        <h1>Your recording session has ended.</h1>
        <p className="muted">If you recorded, the video appears on the dashboard after chunk verification and upload complete.</p>
        <Link className="btn btnPrimary" href="/dashboard">Go to dashboard</Link>
      </section>
    </main>
  );
}
