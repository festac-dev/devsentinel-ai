import Link from "next/link";
import { forgotPasswordAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/action-form";

export default async function ForgotPasswordPage() {
  return (
    <main id="main" className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/login" className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">← Sign in</Link>
        <h1 className="text-2xl font-semibold mt-4 mb-2">Reset your password</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          Enter the email address for your account and we will send you a reset link if the account exists.
        </p>
        <ActionForm
          action={forgotPasswordAction}
          submitLabel="Request reset"
          fields={[{ name: "email", label: "Email", type: "email", required: true, autoComplete: "email" }]}
        />
      </div>
    </main>
  );
}

export const dynamic = "force-dynamic";
