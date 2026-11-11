import type { AskFeedbackRecord } from "../../storage/novaDb";
import type { AskMessage } from "./thread";

export type AskVerdict = "up" | "down";

/** What a rating records about the answer it is for. The answer's own text is not kept. */
export type FeedbackEntry = Pick<AskFeedbackRecord, "messageId" | "conversationId" | "question" | "toolNames" | "grounded" | "revised" | "model" | "offline">;

export type AskFeedbackControls = {
  /** The student's rating per answer, by message id. */
  votes: ReadonlyMap<string, AskVerdict>;
  /** Rates an answer; null takes the rating back. */
  onVote: (entry: FeedbackEntry, verdict: AskVerdict | null) => void;
  /** Saves every rating as a file the student keeps. */
  onExport: () => void;
};

/** An answer the student can rate: finished, not failed, not stopped, and with something to rate. */
export const canRate = (message: AskMessage): boolean => message.role === "assistant" && message.error === null && !message.stopped && message.text.trim() !== "" && message.grounded !== null;

/** The record for one answer: the question that led to it, and how the answer was made. */
export const feedbackEntry = (messages: readonly AskMessage[], messageId: string, conversationId: string): FeedbackEntry | null => {
  const index = messages.findIndex((message) => message.id === messageId);
  const answer = messages[index];
  if (!answer || !canRate(answer)) return null;
  const question = messages
    .slice(0, index)
    .reverse()
    .find((message) => message.role === "user");
  return {
    messageId,
    conversationId,
    question: (question?.text ?? "").slice(0, 2000),
    toolNames: answer.tools.map((tool) => tool.name),
    grounded: answer.grounded,
    revised: answer.revised === true,
    model: answer.model ?? null,
    offline: answer.offline ?? null,
  };
};

export const FEEDBACK_FILE_NAME = "nova-ask-feedback.json";

/** The exported file: plain JSON, readable without Nova, with nothing that identifies the account. */
export const feedbackExport = (records: readonly AskFeedbackRecord[], exportedAt: Date): string =>
  JSON.stringify(
    {
      kind: "nova-ask-feedback",
      version: 1,
      exportedAt: exportedAt.toISOString(),
      count: records.length,
      up: records.filter((record) => record.verdict === "up").length,
      down: records.filter((record) => record.verdict === "down").length,
      ratings: records.map((record) => ({ at: record.at, verdict: record.verdict, question: record.question, tools: record.toolNames, grounded: record.grounded, revised: record.revised, model: record.model, offline: record.offline })),
    },
    null,
    2,
  );
