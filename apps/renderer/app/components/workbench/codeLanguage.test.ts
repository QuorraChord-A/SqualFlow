import { describe, expect, it } from "vitest";
import { codeLanguageExtension, fileExtension, isMarkdownFile, languageFromFilePath } from "./codeLanguage";

describe("codeLanguage", () => {
  it("normalizes file extensions from Unix and Windows paths", () => {
    expect(fileExtension("src/App.TSX")).toBe("tsx");
    expect(fileExtension("C:\\workspace\\config.YAML")).toBe("yaml");
  });

  it("maps supported source files to canonical CodeMirror languages", () => {
    expect(languageFromFilePath("src/lib.rs")).toBe("rust");
    expect(languageFromFilePath("config/settings.toml")).toBe("toml");
    expect(languageFromFilePath("deploy/service.yml")).toBe("yaml");
    expect(languageFromFilePath("src/App.vue")).toBe("vue");
    expect(languageFromFilePath("notes.txt")).toBeUndefined();
  });

  it("provides parsers for yaml, toml, and the vue html fallback", () => {
    expect(codeLanguageExtension("yaml")).not.toHaveLength(0);
    expect(codeLanguageExtension("toml")).not.toHaveLength(0);
    expect(codeLanguageExtension("vue")).not.toHaveLength(0);
  });

  it("keeps Markdown detection separate from source preview routing", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("guide.mdx")).toBe(true);
    expect(isMarkdownFile("src/readme.ts")).toBe(false);
  });
});
