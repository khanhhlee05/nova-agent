import { SendHorizontal, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHAT_LIMITS } from "@nova-agent/protocol";
import { Tip } from "../components/Tip";

/** A question another tab wrote into the composer. `nonce` changes on every request so the same text can be offered twice. */
export type AskDraft = { nonce: number; text: string };

/** The item a prefilled question is about. Sent with the next question, then dropped. */
export type AskAbout = { itemId: string; title: string };

export type AskComposerProps = {
  streaming: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  draft?: AskDraft | null;
  about?: AskAbout | null;
  onClearAbout?: () => void;
  /** The last question asked, recalled with the Up arrow when the field is empty. */
  lastQuestion?: string | null;
  /** Changes when something outside asks for focus (the "/" shortcut). Zero means never. */
  focusNonce?: number;
};

/** The count of characters appears once a question is this long. */
export const COUNTER_FROM = 1500;

/**
 * Enter sends, Shift+Enter breaks the line. One button sends, and stops while
 * an answer streams, so focus never lands on a control that just vanished.
 * Nothing here uses `disabled`: the textarea goes read-only and the button
 * aria-disabled, so both stay focusable and keep their place in the tab order.
 */
export const AskComposer = ({ streaming, disabled, onSend, onStop, draft = null, about = null, onClearAbout, lastQuestion = null, focusNonce = 0 }: AskComposerProps) => {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const wasStreaming = useRef(streaming);
  const inert = !streaming && (disabled || text.trim() === "");

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 112)}px`;
  }, [text]);

  // A question written by another tab replaces what is here and takes focus, ready to edit or send.
  const draftNonce = draft?.nonce ?? null;
  useEffect(() => {
    if (draft === null || draftNonce === null) return;
    setText(draft.text.slice(0, CHAT_LIMITS.message));
    const element = ref.current;
    if (element) {
      element.focus();
      const end = element.value.length;
      requestAnimationFrame(() => element.setSelectionRange(end, end));
    }
    // Keyed on the nonce alone: a re-render with the same draft must not overwrite later typing.
  }, [draftNonce]);

  useEffect(() => {
    if (focusNonce > 0) ref.current?.focus();
  }, [focusNonce]);

  // When an answer ends, return to the textarea if focus was here, on a suggestion chip, or lost with a removed control.
  useEffect(() => {
    if (wasStreaming.current && !streaming && !disabled) {
      const active = document.activeElement;
      const lost = !active || active === document.body || !!form.current?.contains(active) || !!active.closest(".ask-chips") || !!active.closest(".ask-followups");
      if (lost) ref.current?.focus();
    }
    wasStreaming.current = streaming;
  }, [streaming, disabled]);

  const submit = () => {
    const value = text.trim();
    if (value === "" || streaming || disabled) return;
    onSend(value);
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
      return;
    }
    // Up in an empty field brings back the last question, to ask again or to edit. In a field with text it moves the caret as usual.
    if (event.key === "ArrowUp" && text === "" && lastQuestion && !disabled && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      const recalled = lastQuestion.slice(0, CHAT_LIMITS.message);
      setText(recalled);
      const element = event.currentTarget;
      requestAnimationFrame(() => element.setSelectionRange(recalled.length, recalled.length));
    }
  };

  return (
    <form
      ref={form}
      className="ask-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {about ? (
        <p className="ask-about">
          <span className="ask-about-text">
            About <strong title={about.title}>{about.title}</strong>
          </span>
          <Tip label="Ask about everything instead">
            <button type="button" className="icon-button icon-button-sm" aria-label={`Stop asking about ${about.title}`} onClick={onClearAbout}>
              <X size={14} aria-hidden="true" />
            </button>
          </Tip>
        </p>
      ) : null}
      <textarea
        ref={ref}
        className="ask-input"
        rows={1}
        value={text}
        maxLength={CHAT_LIMITS.message}
        placeholder={disabled ? "Turn on Ask Nova above to start" : "Ask about deadlines, changes, or what to start first"}
        aria-label="Ask Nova a question"
        readOnly={disabled}
        aria-disabled={disabled || undefined}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {text.length > COUNTER_FROM ? (
        <span className="ask-remaining mono" data-full={text.length >= CHAT_LIMITS.message || undefined} aria-live="polite" aria-label={`${text.length} of ${CHAT_LIMITS.message} characters`}>
          {text.length.toLocaleString("en-US")} / {CHAT_LIMITS.message.toLocaleString("en-US")}
        </span>
      ) : null}
      <Tip label={streaming ? "Stop" : "Send"}>
        <button type="button" className="icon-button ask-send" data-streaming={streaming} aria-label={streaming ? "Stop answering" : "Send question"} aria-disabled={inert || undefined} onClick={() => (streaming ? onStop() : submit())}>
          {streaming ? <Square size={16} aria-hidden="true" /> : <SendHorizontal size={16} aria-hidden="true" />}
        </button>
      </Tip>
    </form>
  );
};
