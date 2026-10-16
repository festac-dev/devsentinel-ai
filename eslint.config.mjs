import nextCore from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  { ignores: ["node_modules/**", "prisma/migrations/**", "tests/e2e/.auth/**"] },
  ...nextCore,
  ...nextCoreWebVitals,
];

export default config;
