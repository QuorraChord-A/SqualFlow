import type { RuntimeCapability, ToolKind } from "./types";

export function kindForCapability(capability: RuntimeCapability | undefined): ToolKind | null {
  switch (capability) {
    case "read":
      return "read";
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "shell":
      return "bash";
    case "search":
      return "grep";
    case "web_search":
      return "web-search";
    default:
      return null;
  }
}
