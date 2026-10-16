import Link from "next/link";
import { registerAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/action-form";

export default async function RegisterPage() {
  return (
    <main id="main" className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">← DevSentinel AI</Link>
        <h1 className="text-2xl font-semibold mt-4 mb-6">Create your account</h1>
        <ActionForm
          action={registerAction}
          submitLabel="Create account"
          fields={[
            { name: "name", label: "Name", required: true, autoComplete: "name" },
            { name: "email", label: "Email", type: "email", required: true, autoComplete: "email" },
            { name: "password", label: "Password", type: "password", required: true, autoComplete: "new-password", placeholder: "10+ chars, mixed case, digit" },
          ]}
        />
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          Already have an account? <Link href="/login" className="underline">Sign in</Link>
        </p>
      </div>
    </main>
  );
}

export const dynamic = "force-dynamic";
