import { Trash2, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { Tip } from "../components/Tip";
import { formatAge, pluralize } from "../format";
import { MAX_CONVERSATIONS, type ConversationSummary } from "./conversations";

export type AskConversationsProps = {
  conversations: readonly ConversationSummary[];
  /** The conversation on screen, marked in the list. */
  currentId: string;
  now: Date;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
};

/** The saved conversations on this device. Opening one restores the thread; deleting one is immediate and final. */
export const AskConversations = ({ conversations, currentId, now, onOpen, onDelete, onClose }: AskConversationsProps) => (
  <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
    <Dialog.Portal>
      <Dialog.Overlay className="overlay" />
      <Dialog.Content className="dialog ask-conversations" aria-describedby="ask-conversations-note">
        <Dialog.Close className="icon-button icon-button-sm dialog-close" aria-label="Close conversations">
          <X size={14} aria-hidden="true" />
        </Dialog.Close>
        <Dialog.Title asChild>
          <h2>Conversations</h2>
        </Dialog.Title>
        <Dialog.Description asChild>
          <p id="ask-conversations-note">Saved on this device only. Nova keeps the newest {MAX_CONVERSATIONS}.</p>
        </Dialog.Description>
        {conversations.length === 0 ? (
          <p className="ask-conversations-empty">No saved conversations yet. The next question you ask starts one.</p>
        ) : (
          <ul className="ask-conversation-list" aria-label="Saved conversations">
            {conversations.map((conversation) => {
              const current = conversation.id === currentId;
              return (
                <li key={conversation.id} className="ask-conversation" data-current={current || undefined}>
                  <button
                    type="button"
                    className="ask-conversation-open"
                    aria-current={current ? "true" : undefined}
                    onClick={() => {
                      if (!current) onOpen(conversation.id);
                      onClose();
                    }}
                  >
                    <span className="ask-conversation-title">{conversation.title}</span>
                    <span className="ask-conversation-meta">
                      {pluralize(conversation.questions, "question")} · {formatAge(conversation.updatedAt, now)}
                      {current ? " · Open now" : ""}
                    </span>
                  </button>
                  <Tip label="Delete">
                    <button type="button" className="icon-button icon-button-sm" aria-label={`Delete conversation "${conversation.title}"`} onClick={() => onDelete(conversation.id)}>
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </Tip>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);
