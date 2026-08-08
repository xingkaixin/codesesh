import astro from "eslint-plugin-astro";
import tseslint from "typescript-eslint";

export default [
  { ignores: [".astro/**", "dist/**"] },
  ...astro.configs.recommended,
  ...astro.configs["jsx-a11y-recommended"],
  {
    files: ["**/*.astro"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      "astro/jsx-a11y/no-noninteractive-tabindex": ["error", { roles: ["tabpanel", "region"] }],
    },
  },
];
