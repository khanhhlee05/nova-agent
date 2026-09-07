export type AcademicItem = {
  key: string;
  brightspaceId: string;
  courseId: string;
  kind: "assignment" | "quiz";
  title: string;
  dueAt: string | null;
  completed: boolean;
  hidden: boolean;
  url: string;
  lastObservedAt: string;
};
