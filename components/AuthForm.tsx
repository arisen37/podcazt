"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { getApiErrorMessage } from "@/lib/client-error";

type Mode = "signin" | "login";

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [currentMode, setCurrentMode] = useState<Mode>(mode);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const payload =
      currentMode === "signin"
        ? {
            emailId: String(form.get("emailId")),
            password: String(form.get("password")),
            name: String(form.get("name")),
            username: String(form.get("username"))
          }
        : {
            emailId: String(form.get("emailId")),
            password: String(form.get("password"))
          };

    const response = await fetch(`/api/${currentMode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(getApiErrorMessage(body, "Authentication failed"));
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form className="formGrid" onSubmit={submit}>
      {currentMode === "signin" && (
        <>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" autoComplete="name" required />
          </div>
          <div className="field">
            <label htmlFor="username">Username</label>
            <input id="username" name="username" autoComplete="username" required />
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="emailId">Email</label>
        <input id="emailId" type="email" name="emailId" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          name="password"
          autoComplete={currentMode === "signin" ? "new-password" : "current-password"}
          minLength={8}
          maxLength={15}
          required
        />
        <small className="fieldHint">8–15 characters with at least one uppercase letter.</small>
      </div>
      {error && <div className="alert">{error}</div>}
      <button className="btn btnPrimary" disabled={loading}>
        {loading ? "Please wait..." : currentMode === "signin" ? "Create account" : "Login"}
      </button>
      <p className="muted authSwitch">
        {currentMode === "signin" ? "Already have an account?" : "Need an account?"}{" "}
        <button
          type="button"
          className="linkButton"
          onClick={() => {
            setError("");
            setCurrentMode(currentMode === "signin" ? "login" : "signin");
          }}
        >
          {currentMode === "signin" ? "Login" : "Sign up"}
        </button>
      </p>
    </form>
  );
}
