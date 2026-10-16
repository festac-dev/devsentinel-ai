import { describe, it, expect } from "vitest";
import { InvestigationSections } from "@/modules/investigation/provider";

/**
 * The AI output schema is the guardrail against fabricated evidence:
 * outputs that do not match are rejected, never displayed.
 */
describe("AI investigation output schema", () => {
  it("accepts a well-formed four-section output", () => {
    const parsed = InvestigationSections.safeParse({
      confirmedFacts: [{ text: "Run failed", evidenceRef: "run:abc" }],
      possibleCause: ["The deployment was down"],
      unknown: ["Whether the fix was deployed"],
      recommendedAction: ["Re-run the test after deploying"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects outputs missing sections or with wrong shapes", () => {
    expect(InvestigationSections.safeParse({}).success).toBe(false);
    expect(InvestigationSections.safeParse({ confirmedFacts: "yes" }).success).toBe(false);
    expect(
      InvestigationSections.safeParse({
        confirmedFacts: [{ evidenceRef: "run:abc" }], // missing text
        possibleCause: [],
        unknown: [],
        recommendedAction: [],
      }).success
    ).toBe(false);
    expect(
      InvestigationSections.safeParse({
        confirmedFacts: [{ text: "x", evidenceRef: 42 }], // wrong type
        possibleCause: [],
        unknown: [],
        recommendedAction: [],
      }).success
    ).toBe(false);
  });

  it("caps section sizes", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ text: `f${i}`, evidenceRef: "run:x" }));
    expect(InvestigationSections.safeParse({ confirmedFacts: many, possibleCause: [], unknown: [], recommendedAction: [] }).success).toBe(false);
  });
});
