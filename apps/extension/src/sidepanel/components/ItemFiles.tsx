import type { AcademicItem, ItemAttachment } from "@nova-agent/core";
import { FileText } from "lucide-react";
import { attachmentBody, attachmentNote, formatBytes } from "../../files/attachments";
import type { AttachmentTextRecord } from "../../storage/novaDb";
import { formatRelative } from "../format";

/** What the item details need to show an assignment's files and read one. */
export type AttachmentControls = {
  /** Files already read on this device, by `${itemKey}#${fileId}`. */
  texts: ReadonlyMap<string, AttachmentTextRecord>;
  /** Files being downloaded and read right now, by the same key. */
  busy: ReadonlySet<string>;
  /** Why the last read of a file failed, by the same key. */
  errors: ReadonlyMap<string, string>;
  onRead: (item: AcademicItem, attachment: ItemAttachment) => void;
};

export type ItemFilesProps = { item: AcademicItem; now: Date; controls?: AttachmentControls };

/**
 * The files on an assignment, by name. With `controls`, each can be read:
 * downloaded once through the student's Brightspace session, its text kept
 * on this device for Ask Nova. Without them the list is names only.
 */
export const ItemFiles = ({ item, now, controls }: ItemFilesProps) => {
  const files = item.attachments ?? [];
  if (files.length === 0) return null;
  return (
    <section className="files" aria-label="Files">
      <p className="files-title">Files</p>
      <ul className="files-list">
        {files.map((file) => {
          const key = `${item.key}#${file.id}`;
          const record = controls?.texts.get(key);
          const busy = controls?.busy.has(key) ?? false;
          const error = controls?.errors.get(key);
          const note = record ? attachmentNote(record) : null;
          return (
            <li key={`${file.source}-${file.id}`} className="file">
              <FileText size={15} aria-hidden="true" className="file-icon" />
              <div className="file-main">
                <span className="file-name" title={file.name}>
                  {file.name}
                </span>
                <span className="file-meta">
                  {file.source === "instructor" ? "From your instructor" : "You handed this in"} · {formatBytes(file.size)}
                </span>
                {error ? (
                  <span className="file-note" data-tone="error" role="alert">
                    {error}
                  </span>
                ) : record ? (
                  <span className="file-note" data-tone={note ? undefined : "ok"}>
                    {note ?? `Read ${formatRelative(record.extractedAt, now)}. ${attachmentBody(record).length.toLocaleString("en-US")} characters of text kept on this device${record.truncated ? ", the first part of a longer file" : ""}.`}
                  </span>
                ) : null}
              </div>
              {controls && !record ? (
                <button type="button" className="button button-sm" disabled={busy} aria-label={busy ? `Reading ${file.name}` : `Read ${file.name}`} onClick={() => controls.onRead(item, file)}>
                  {busy ? "Reading…" : error ? "Try again" : "Read"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {controls ? <p className="files-hint">Reading downloads the file through your Brightspace session and keeps its text on this device, so Ask Nova can answer from it.</p> : null}
    </section>
  );
};
