import { act } from "@testing-library/react";
import baseUserEvent from "@testing-library/user-event";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  KEY_BACKSPACE_COMMAND,
  type LexicalEditor,
} from "lexical";

type LexicalRootElement = HTMLElement & {
  __lexicalEditor?: LexicalEditor;
};

function lexicalEditorFor(element: Element) {
  return (element as LexicalRootElement).__lexicalEditor;
}

export function setupRichEditorUser() {
  const user = baseUserEvent.setup();
  return new Proxy(user, {
    get(target, property, receiver) {
      if (property === "type") {
        return async (
          element: Element,
          text: string,
          options?: Parameters<typeof user.type>[2],
        ) => {
          const editor = lexicalEditorFor(element);
          if (!editor) return user.type(element, text, options);
          (element as HTMLElement).focus();
          await act(async () => {
            editor.update(
              () => {
                $getRoot().selectEnd();
                const selection = $getSelection();
                if ($isRangeSelection(selection)) selection.insertText(text);
              },
              { discrete: true },
            );
            await Promise.resolve();
          });
        };
      }
      if (property === "clear") {
        return async (element: Element) => {
          const editor = lexicalEditorFor(element);
          if (!editor) return user.clear(element);
          (element as HTMLElement).focus();
          await act(async () => {
            editor.update(
              () => {
                const root = $getRoot();
                root.clear();
                root.append($createParagraphNode());
                root.selectEnd();
              },
              { discrete: true },
            );
            await Promise.resolve();
          });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export async function deleteRichEditorTrailingCharacter(element: Element) {
  const editor = lexicalEditorFor(element);
  if (!editor) throw new Error("Expected a Lexical rich editor");
  (element as HTMLElement).focus();
  await act(async () => {
    editor.update(
      () => {
        const root = $getRoot();
        const trailingNode = root.getLastDescendant();
        if ($isTextNode(trailingNode) && trailingNode.getTextContentSize() > 0) {
          trailingNode.spliceText(trailingNode.getTextContentSize() - 1, 1, "");
        }
        root.selectEnd();
      },
      { discrete: true },
    );
    await Promise.resolve();
  });
}

export async function pressRichEditorBackspace(element: Element) {
  const editor = lexicalEditorFor(element);
  if (!editor) throw new Error("Expected a Lexical rich editor");
  (element as HTMLElement).focus();
  await act(async () => {
    editor.dispatchCommand(
      KEY_BACKSPACE_COMMAND,
      new KeyboardEvent("keydown", { key: "Backspace" }),
    );
    await Promise.resolve();
  });
}
