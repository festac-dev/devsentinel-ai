import Link from "next/link";
import { loginAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/action-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ registered?: string }> }) {
  const { registered } = await searchParams;
  return (
    <main id="main" className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">← DevSentinel AI</Link>
        {registered ? (
          <div role="status" className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            <p className="font-medium">Welcome to DevSentinel AI</p>
            <p>
              Your account has been created.{registered === "sent" ? " A welcome email is on its way to your inbox." : ""} Sign in below to get started.
            </p>
          </div>
        ) : null}
        <h1 className="text-2xl font-semibold mt-4 mb-6">Sign in</h1>
        <ActionForm
          action={loginAction}
          submitLabel="Sign in"
          fields={[
            { name: "email", label: "Email", type: "email", required: true, autoComplete: "email" },
            { name: "password", label: "Password", type: "password", required: true, autoComplete: "current-password" },
          ]}
        />
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          No account? <Link href="/register" className="underline">Create one</Link> ·{" "}
          <Link href="/forgot-password" className="underline">Forgot password?</Link>
        </p>
      </div>
    </main>
  );
}

export const dynamic = "force-dynamic";
