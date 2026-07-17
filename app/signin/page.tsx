import { AuthForm } from "@/components/AuthForm";

export default function SigninPage() {
  return (
    <main className="shell signinHero">
      <section className="signinCopy">
        <p className="pill">Browser recording + podcast invites</p>
        <h1>Start recording in minutes.</h1>
        <p>Create a Podcazt account to record solo episodes or invite guests into a podcast room.</p>
      </section>
      <section className="card formCard signinCard">
        <h2>Sign up / Login</h2>
        <AuthForm mode="signin" />
      </section>
    </main>
  );
}
