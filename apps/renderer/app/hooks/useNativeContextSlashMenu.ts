"use client";

import { useEffect, useState } from "react";
import type {
  PromptSlashMenuData,
  PromptSlashMenuItem,
} from "@/components/ai-elements-official/prompt-input";
import {
  fetchNativeContext,
  type NativeContextItemDto,
} from "../lib/api";

function slashItem(
  item: NativeContextItemDto,
  kind: "skill" | "mcp",
  index: number,
): PromptSlashMenuItem {
  return {
    id: `${kind}-${item.scope}-${item.path ?? ""}-${item.name}-${index}`,
    name: item.name,
    description: item.description,
    scope: item.scope,
    kind,
    reference: kind === "skill" ? item.path ?? undefined : undefined,
  };
}

export function useNativeContextSlashMenu(input: {
  flowId?: string | null;
  configId?: string | null;
  refreshKey?: number;
}): PromptSlashMenuData {
  const [menu, setMenu] = useState<PromptSlashMenuData>({
    skills: [],
    mcpServers: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!input.flowId && !input.configId) {
      setMenu({ skills: [], mcpServers: [], loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setMenu((current) => ({ ...current, loading: true, error: null }));
    void fetchNativeContext({
      flowId: input.flowId,
      configId: input.configId,
    })
      .then((snapshot) => {
        if (controller.signal.aborted) return;
        setMenu({
          skills: snapshot.skills.map((item, index) => slashItem(item, "skill", index)),
          mcpServers: snapshot.mcpServers.map((item, index) => slashItem(item, "mcp", index)),
          loading: false,
          error: null,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setMenu({
          skills: [],
          mcpServers: [],
          loading: false,
          error: error instanceof Error ? error.message : "无法读取 Skills 与 MCP",
        });
      });
    return () => controller.abort();
  }, [input.configId, input.flowId, input.refreshKey]);

  return menu;
}
