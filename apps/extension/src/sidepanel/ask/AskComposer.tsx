import { SendHorizontal, Square } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHAT_LIMITS } from "@nova-agent/protocol";
import { Tip } from "../components/Tip";

export type AskComposerProps = {
  streaming: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
};

/**
 * Enter sends, Shift+Enter breaks the line. One button sends, and stops while
 * an answer streams, so focus never lands on a control that just vanished.
 * Nothing here uses `disabled`: the textarea goes read-only and the button
 * aria-disabled, so both stay focusable and keep their place in the tab order.
 */
export const AskComposer = ({ streaming, disabled, onSend, onStop }: AskComposerProps) => {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const wasStreaming = useRef(streaming);
  const remaining = CHAT_LIMITS.message - text.length;
  const inert = !streaming && (disabled || text.trim() === "");

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 112)}px`;
  }, [text]);

  // When an answer ends, return to the textarea if focus was here, on a suggestion chip, or lost with a removed control.
  useEffect(() => {
    if (wasStreaming.current && !streaming && !disabled) {
      const active = document.activeElement;
      const lost = !active || active === document.body || !!form.current?.contains(active) || !!active.closest(".ask-chips");
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
      {remaining < 200 ? (
        <span className="ask-remaining mono" aria-live="polite">
          {remaining}
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
