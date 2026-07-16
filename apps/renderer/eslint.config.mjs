import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

const literalThemeColorPattern = /(?:#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|(?:bg|text|border|ring|shadow)-(?:white|black)(?:\/|\b))/;

const themeTokensPlugin = {
  rules: {
    "no-literal-theme-colors": {
      meta: {
        type: "problem",
        docs: {
          description: "Require semantic theme tokens instead of component-local colors",
        },
        messages: {
          literalColor: "Use a semantic theme token instead of a literal color in component code.",
        },
        schema: [],
      },
      create(context) {
        const checkValue = (node, value) => {
          if (typeof value === "string" && literalThemeColorPattern.test(value)) {
            context.report({ node, messageId: "literalColor" });
          }
        };

        return {
          Literal(node) {
            checkValue(node, node.value);
          },
          TemplateElement(node) {
            checkValue(node, node.value.raw);
          },
        };
      },
    },
  },
};

const eslintConfig = [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    files: ["app/components/**/*.tsx", "components/**/*.tsx"],
    plugins: {
      "theme-tokens": themeTokensPlugin,
    },
    rules: {
      "theme-tokens/no-literal-theme-colors": "error",
    },
  },
  {
    ignores: ["node_modules/", ".next/", "out/"],
  },
];

export default eslintConfig;
