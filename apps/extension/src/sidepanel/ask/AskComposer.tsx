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

/** Enter sends, Shift+Enter breaks the line. Stop replaces Send while an answer streams. */
export const AskComposer = ({ streaming, disabled, onSend, onStop }: AskComposerProps) => {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const remaining = CHAT_LIMITS.message - text.length;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 112)}px`;
  }, [text]);

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
        disabled={disabled || streaming}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {remaining < 200 ? (
        <span className="ask-remaining mono" aria-live="polite">
          {remaining}
        </span>
      ) : null}
      {streaming ? (
        <Tip label="Stop">
          <button type="button" className="icon-button ask-send" aria-label="Stop answering" onClick={onStop}>
            <Square size={16} aria-hidden="true" />
          </button>
        </Tip>
      ) : (
        <Tip label="Send">
          <button type="submit" className="icon-button ask-send" aria-label="Send question" disabled={disabled || text.trim() === ""}>
            <SendHorizontal size={16} aria-hidden="true" />
          </button>
        </Tip>
      )}
    </form>
  );
};
