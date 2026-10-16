import { resetPasswordAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/action-form";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main id="main" className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold mb-6">Choose a new password</h1>
        <ActionForm
          action={resetPasswordAction}
          submitLabel="Reset password"
          hidden={{ token: token ?? "" }}
          fields={[{ name: "password", label: "New password", type: "password", required: true, autoComplete: "new-password", placeholder: "10+ chars, mixed case, digit" }]}
        />
      </div>
    </main>
  );
}

export const dynamic = "force-dynamic";
