/** Path of the shared MOCK TestSprite CLI fixture (spec 20; mocked provider). */
import { fileURLToPath } from "node:url";

export const FAKE_TESTSPRITE_CLI = fileURLToPath(new URL("../../e2e/fixtures/fake-testsprite.cjs", import.meta.url));
