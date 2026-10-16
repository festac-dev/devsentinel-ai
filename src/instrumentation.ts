/**
 * Next.js instrumentation entry. Kept import-free on purpose: this file is
 * compiled for both runtimes, so all boot logic lives in src/server-boot.ts
 * (Node runtime) and is pulled in dynamically from register().
 *
 * The NEXT_RUNTIME guard keeps the Node-only boot code (process.on, process.cwd,
 * child_process, Prisma) out of the Edge instrumentation bundle, which otherwise
 * emits "Node.js API is used ... not supported in the Edge Runtime" warnings.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { boot } = await import("./server-boot");
  await boot();
}
