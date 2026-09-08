import type { AcademicItem, ChangeEvent } from "@nova-agent/core";
import {
  AlarmClock,
  ArrowRightLeft,
  CheckCircle2,
  Circle,
  CircleHelp,
  EyeOff,
  Eye,
  FileText,
  ListChecks,
  LoaderCircle,
  Megaphone,
  PencilLine,
  Plus,
  Trash2,
} from "lucide-react";

export const KindIcon = ({ kind, size = 16 }: { kind: AcademicItem["kind"]; size?: number }) =>
  kind === "quiz" ? <ListChecks size={size} aria-hidden="true" /> : <FileText size={size} aria-hidden="true" />;

export const StatusIcon = ({ status, size = 16 }: { status: AcademicItem["status"]; size?: number }) => {
  switch (status) {
    case "submitted":
    case "completed":
      return <CheckCircle2 size={size} aria-hidden="true" />;
    case "in-progress":
      return <LoaderCircle size={size} aria-hidden="true" />;
    case "unknown":
      return <CircleHelp size={size} aria-hidden="true" />;
    default:
      return <Circle size={size} aria-hidden="true" />;
  }
};

export type Tone = "blue" | "coral" | "amber" | "mint";

export const changeIcon = (event: ChangeEvent): { icon: React.ReactNode; tone: Tone } => {
  switch (event.kind) {
    case "item-added":
      return { icon: <Plus size={15} aria-hidden="true" />, tone: "blue" };
    case "due-date-changed":
      return { icon: <ArrowRightLeft size={15} aria-hidden="true" />, tone: "blue" };
    case "became-overdue":
      return { icon: <AlarmClock size={15} aria-hidden="true" />, tone: "coral" };
    case "status-changed":
      return { icon: <CheckCircle2 size={15} aria-hidden="true" />, tone: "mint" };
    case "visibility-changed":
      return event.after?.visibility === "hidden"
        ? { icon: <EyeOff size={15} aria-hidden="true" />, tone: "blue" }
        : { icon: <Eye size={15} aria-hidden="true" />, tone: "blue" };
    case "item-removed":
      return { icon: <Trash2 size={15} aria-hidden="true" />, tone: "blue" };
    case "announcement-added":
      return { icon: <Megaphone size={15} aria-hidden="true" />, tone: "blue" };
    case "announcement-updated":
      return { icon: <PencilLine size={15} aria-hidden="true" />, tone: "blue" };
  }
};
