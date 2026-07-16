"use client";

export type MessageImageKind = "image" | "browser_comment";

export type MessageImageAttachment = {
  id: string;
  kind: MessageImageKind;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataUrl: string;
  name?: string;
  width?: number;
  height?: number;
  markerNumber?: number;
  comment?: string;
  label?: string;
  pageUrl?: string;
  selector?: string;
  textOffset?: number;
  addedAt: number;
};

export type OutgoingMessageImageAttachment = {
  id: string;
  kind: MessageImageKind;
  media_type?: MessageImageAttachment["mediaType"];
  data?: string;
  name?: string;
  width?: number;
  height?: number;
  marker_number?: number;
  comment?: string;
  label?: string;
  page_url?: string;
  selector?: string;
  text_offset?: number;
};

export function splitDataUrl(dataUrl: string): { mediaType: MessageImageAttachment["mediaType"]; data: string } | null {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl);
  if (!match) return null;
  return { mediaType: match[1] as MessageImageAttachment["mediaType"], data: match[2] };
}

export function dataUrlFromImage(mediaType: MessageImageAttachment["mediaType"], data: string) {
  return `data:${mediaType};base64,${data}`;
}

export function outgoingImageAttachment(attachment: MessageImageAttachment): OutgoingMessageImageAttachment | null {
  const parsed = splitDataUrl(attachment.dataUrl);
  if (!parsed) return null;
  return {
    id: attachment.id,
    kind: attachment.kind,
    media_type: parsed.mediaType,
    data: parsed.data,
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(typeof attachment.width === "number" ? { width: attachment.width } : {}),
    ...(typeof attachment.height === "number" ? { height: attachment.height } : {}),
    ...(typeof attachment.markerNumber === "number" ? { marker_number: attachment.markerNumber } : {}),
    ...(attachment.comment ? { comment: attachment.comment } : {}),
    ...(attachment.label ? { label: attachment.label } : {}),
    ...(attachment.pageUrl ? { page_url: attachment.pageUrl } : {}),
    ...(attachment.selector ? { selector: attachment.selector } : {}),
    ...(typeof attachment.textOffset === "number" ? { text_offset: attachment.textOffset } : {}),
  };
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number } | null> {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Image paste did not produce a data URL"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read pasted image"));
    reader.readAsDataURL(file);
  });
}

export async function imageAttachmentFromFile(file: File, textOffset?: number): Promise<MessageImageAttachment | null> {
  if (!/^image\/(?:png|jpeg|webp|gif)$/u.test(file.type)) return null;
  const dataUrl = await readFileAsDataUrl(file);
  const parsed = splitDataUrl(dataUrl);
  if (!parsed) return null;
  const size = await imageSize(dataUrl);
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "image",
    mediaType: parsed.mediaType,
    dataUrl,
    name: file.name || "pasted-image",
    ...(size ? { width: size.width, height: size.height } : {}),
    ...(typeof textOffset === "number" ? { textOffset } : {}),
    addedAt: Date.now(),
  };
}
