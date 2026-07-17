import { redirect } from "next/navigation";
import { CreateRoomForm } from "@/components/CreateRoomForm";
import { getCurrentUser } from "@/lib/auth";

export default async function CreatePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  return (
    <main className="shell page">
      <div className="topbar">
        <div>
          <p className="pill">Choose recording format</p>
          <h1 className="pageTitle">Create</h1>
        </div>
      </div>
      <CreateRoomForm />
    </main>
  );
}
