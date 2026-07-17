import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PermissionGate } from "@/components/PermissionGate";
import { getCurrentUser } from "@/lib/auth";

export default async function PermissionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  return (
    <main className="shell hero">
      <section>
        <p className="pill">Preflight check</p>
        <h1>Set up your devices.</h1>
        <p>Confirm camera and mic access before joining the recording room.</p>
      </section>
      <Suspense fallback={<div className="card formCard">Loading...</div>}>
        <PermissionGate />
      </Suspense>
    </main>
  );
}
