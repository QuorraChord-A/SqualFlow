"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { ArrowDownIcon, DownloadIcon } from "lucide-react";
import type { ComponentProps } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// ── Context for scroll state ──

interface ConversationScrollContextValue {
  isAtBottom: boolean;
  scrollToBottom: () => void;
}

const ConversationScrollContext = createContext<ConversationScrollContextValue>({
  isAtBottom: true,
  scrollToBottom: () => {},
});

// ── Conversation ──
// The scroll container itself. Only auto-scrolls on NEW messages,
// not when collapsible content (Reasoning/Tool) is toggled.

export type ConversationProps = ComponentProps<"div"> & {
  messages?: UIMessage[];
};

export const Conversation = ({
  className,
  messages,
  children,
  ...props
}: ConversationProps) => {
  const scrollElRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const userScrolledUpRef = useRef(false);
  const prevMsgCountRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = scrollElRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      userScrolledUpRef.current = false;
    }
  }, []);

  // Track scroll position
  useEffect(() => {
    const el = scrollElRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setIsAtBottom(atBottom);
      if (!atBottom) {
        userScrolledUpRef.current = true;
      } else {
        userScrolledUpRef.current = false;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll only when NEW messages are added (not on collapse/expand)
  useEffect(() => {
    if (!messages) return;
    const count = messages.length;
    if (count > prevMsgCountRef.current && !userScrolledUpRef.current) {
      scrollToBottom();
    }
    prevMsgCountRef.current = count;
  }, [messages, scrollToBottom]);

  return (
    <ConversationScrollContext.Provider value={{ isAtBottom, scrollToBottom }}>
      <div
        ref={scrollElRef}
        className={cn(
          "relative flex-1 overflow-y-auto",
          className
        )}
        role="log"
        {...props}
      >
        {children}
      </div>
    </ConversationScrollContext.Provider>
  );
};

// ── ConversationContent ──

export type ConversationContentProps = ComponentProps<"div">;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <div
    className={cn("flex flex-col gap-8 p-4", className)}
    {...props}
  />
);

// ── ConversationEmptyState ──

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

// ── ConversationScrollButton ──

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useContext(ConversationScrollContext);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className
        )}
        onClick={scrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};

// ── ConversationDownload ──

const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

export type ConversationDownloadProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  messages: UIMessage[];
  filename?: string;
  formatMessage?: (message: UIMessage, index: number) => string;
};

const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel =
    message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${getMessageText(message)}`;
};

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messages.map((msg) => formatMessage(msg, 0)).join("\n\n");
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  return (
    <Button
      className={cn(
        "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted",
        className
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  );
};
