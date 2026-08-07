import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { wsClient } from "../lib/ws";
import { useFlowWorkbench } from "./useFlowWorkbench";

vi.mock("../lib/ws", () => {
  const handlers = new Map<string, Set<(message: { flow_id?: string }) => void>>();
  return {
    wsClient: {
      onEvent: vi.fn((type: string, handler: (message: { flow_id?: string }) => void) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(handler);
        return () => handlers.get(type)?.delete(handler);
      }),
      __emit(type: string, message: { flow_id?: string }) {
        for (const handler of handlers.get(type) ?? []) handler(message);
      },
    },
  };
});

describe("useFlowWorkbench", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces the initial load with the first flow state refresh", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useFlowWorkbench("flow-1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: { flow_id?: string }) => void })
        .__emit("flow:state", { flow_id: "flow-1" });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(JSON.stringify({
      team: { leader: null, experts: [] },
      artifacts: { specs: [], files: [], reports: [] },
      tasks: [],
      files: { root_path: null, tree_available: false },
      reviews: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
