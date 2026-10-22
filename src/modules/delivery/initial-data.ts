/**
 * Versioned initial delivery state for the DevSentinel AI four-phase build.
 *
 * The supplied checklist is a REPORTED state, not independent proof. Every
 * seeded task therefore starts as status "completed" / verification
 * "unverified", with an audit event explaining the provenance. Re-running
 * initialization only adds missing phases/tasks; it never rewrites user work.
 */

export const DELIVERY_SEED_VERSION = 1;

export const DELIVERY_METADATA = {
  title: "DevSentinel AI",
  description:
    "Developer operations and automated testing platform: GitHub pull-request testing through genuine TestSprite runs, commit-bound results, monitoring, incidents, and evidence-driven delivery tracking.",
  liveUrl: "https://devsentinel-ai-festac.vercel.app",
  repositoryUrl: "https://github.com/festac-dev/devsentinel-ai",
} as const;

export type InitialDeliveryTask = {
  stableKey: string;
  title: string;
  description: string;
  taskOrder: number;
};

export type InitialDeliveryPhase = {
  stableKey: string;
  title: string;
  description: string;
  phaseOrder: number;
  tasks: readonly InitialDeliveryTask[];
};

export const INITIAL_DELIVERY_PHASES: readonly InitialDeliveryPhase[] = [
  {
    stableKey: "phase-1-audit-stabilize",
    title: "Audit and Stabilize",
    description:
      "Establish a trustworthy baseline: inspect the implementation, run every quality gate, review security boundaries, and verify deployment health.",
    phaseOrder: 1,
    tasks: [
      {
        stableKey: "p1-inspect-code-schema-routes-worker",
        title: "Inspect code, schema, API routes, and worker lifecycle",
        description: "Inspect the current code, schema, API routes, and worker lifecycle.",
        taskOrder: 1,
      },
      {
        stableKey: "p1-run-quality-gates",
        title: "Run typecheck, lint, tests, and production build",
        description: "Run typecheck, lint, unit tests, database integration tests, and production build.",
        taskOrder: 2,
      },
      {
        stableKey: "p1-audit-security-boundaries",
        title: "Audit authorization, SSRF, subprocesses, and secrets",
        description: "Audit authorization, SSRF, subprocess execution, and secret handling.",
        taskOrder: 3,
      },
      {
        stableKey: "p1-verify-deployment-health",
        title: "Verify health endpoints and deployment configuration",
        description: "Verify deployed health endpoints and deployment configuration.",
        taskOrder: 4,
      },
    ],
  },
  {
    stableKey: "phase-2-product-experience",
    title: "Product Experience",
    description:
      "Make the product usable and diagnosable end to end: responsive navigation, onboarding, evidence timelines, filtering, and recovery states.",
    phaseOrder: 2,
    tasks: [
      {
        stableKey: "p2-upgrade-dashboard-navigation",
        title: "Upgrade dashboard and responsive navigation",
        description: "Upgrade dashboard and responsive navigation.",
        taskOrder: 1,
      },
      {
        stableKey: "p2-improve-onboarding-diagnostics",
        title: "Improve onboarding and integration diagnostics",
        description: "Improve onboarding and integration diagnostics.",
        taskOrder: 2,
      },
      {
        stableKey: "p2-build-evidence-timelines",
        title: "Build PR, run-detail, and incident evidence timelines",
        description: "Build PR, run-detail, and incident evidence timelines.",
        taskOrder: 3,
      },
      {
        stableKey: "p2-add-filtering-search-recovery",
        title: "Add filtering, search, loading, and error recovery",
        description: "Add filtering, search, loading states, and error recovery.",
        taskOrder: 4,
      },
    ],
  },
  {
    stableKey: "phase-3-reliability",
    title: "Reliability",
    description:
      "Harden the operational core: queue recovery, provider resource controls, monitor recovery, notification delivery, and backup failure scenarios.",
    phaseOrder: 3,
    tasks: [
      {
        stableKey: "p3-harden-queue-lifecycle",
        title: "Harden retries, lease recovery, and duplicate jobs",
        description: "Harden queue retries, lease recovery, and duplicate-job handling.",
        taskOrder: 1,
      },
      {
        stableKey: "p3-add-provider-guardrails",
        title: "Add provider timeouts, cancellation, and limits",
        description: "Add provider timeouts, cancellation, and resource limits.",
        taskOrder: 2,
      },
      {
        stableKey: "p3-monitor-recovery-delivery",
        title: "Implement monitor recovery and notification delivery tracking",
        description: "Implement monitor recovery detection and notification delivery tracking.",
        taskOrder: 3,
      },
      {
        stableKey: "p3-test-backup-failure-scenarios",
        title: "Test backup restoration and failure scenarios",
        description: "Test backup restoration and failure scenarios.",
        taskOrder: 4,
      },
    ],
  },
  {
    stableKey: "phase-4-real-integrations",
    title: "Real Integrations",
    description:
      "Prove the integration chain with genuine providers and commit-specific publication, including stale-commit races, provider outages, and reproducible evidence.",
    phaseOrder: 4,
    tasks: [
      {
        stableKey: "p4-connect-real-providers",
        title: "Connect the genuine TestSprite provider and GitHub App",
        description: "Connect the genuine TestSprite provider and GitHub App.",
        taskOrder: 1,
      },
      {
        stableKey: "p4-real-pr-commit-checks",
        title: "Open a real PR and verify commit-specific checks",
        description: "Open a real PR and verify commit-specific check publication.",
        taskOrder: 2,
      },
      {
        stableKey: "p4-test-races-outages",
        title: "Test stale-commit races and provider outages",
        description: "Test stale-commit races and provider outages.",
        taskOrder: 3,
      },
      {
        stableKey: "p4-publish-reproducible-evidence",
        title: "Publish reproducible test evidence and an honest demo",
        description: "Publish reproducible test evidence and an honest demo.",
        taskOrder: 4,
      },
    ],
  },
] as const;

export const INITIAL_DELIVERY_TASK_COUNT = INITIAL_DELIVERY_PHASES.reduce(
  (total, phase) => total + phase.tasks.length,
  0
);
