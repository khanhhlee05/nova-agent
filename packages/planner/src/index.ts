export type PriorityInput = { overdue: boolean; hoursUntilDue: number | null };
export const calculatePriority = ({ overdue, hoursUntilDue }: PriorityInput): number => {
  if (overdue) return 100;
  if (hoursUntilDue === null) return 0;
  return Math.max(0, 72 - hoursUntilDue);
};
