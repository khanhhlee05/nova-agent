import { Undo2 } from "lucide-react";
import { useEffect, useRef } from "react";

export type UndoToastProps = { message: string; onUndo: () => void };

/**
 * The only way back from a delete. The row the student deleted from is gone,
 * so focus moves here; when the toast leaves, focus returns to the content
 * instead of falling to the document body.
 */
export const UndoToast = ({ message, onUndo }: UndoToastProps) => {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = root.current;
    const active = document.activeElement;
    if (!active || active === document.body || !document.contains(active)) button.current?.focus();
    return () => {
      if (element?.contains(document.activeElement) || document.activeElement === document.body) document.getElementById("panel-main")?.focus();
    };
  }, []);

  return (
    <div ref={root} className="undo-toast" role="status">
      <span className="undo-toast-text">{message}</span>
      <button ref={button} type="button" className="undo-toast-button" onClick={onUndo}>
        <Undo2 size={14} aria-hidden="true" />
        Undo
      </button>
    </div>
  );
};
