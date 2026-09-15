import { z } from "zod";
import { MAX_ROWS, announcementRow, courseName, defineTool, plural, resolveCourse } from "./shared";

export const getRecentAnnouncements = defineTool({
  name: "get_recent_announcements",
  description: "Recent course announcements (title, course, date, pinned). Bodies are not available; offer the link instead. Default window is the last 7 days plus pinned announcements.",
  input: z.object({
    course: z.string().max(120).optional().describe("Course id, code, or part of the course name."),
    sinceHours: z.number().int().min(1).max(24 * 60).optional().describe("How far back to look, in hours. Default 168 (7 days)."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum announcements. Default 10."),
  }),
  run: (input, { snapshot }) => {
    const { course, error } = resolveCourse(snapshot, input.course);
    if (error) return { ok: false, error };
    const sinceHours = input.sinceHours ?? 168;
    const cutoff = new Date(snapshot.now).getTime() - sinceHours * 3_600_000;
    const matches = snapshot.announcements
      .filter((announcement) => (course ? announcement.courseId === course.id : true))
      .filter((announcement) => announcement.pinned || (announcement.createdAt !== null && new Date(announcement.createdAt).getTime() >= cutoff))
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.title.localeCompare(b.title));
    const shown = matches.slice(0, Math.min(input.limit ?? 10, MAX_ROWS));
    return {
      ok: true,
      summary: `${plural(matches.length, "announcement")}${course ? ` in ${course.name}` : ""} in the last ${sinceHours} hours.`,
      data: {
        announcements: shown.map((announcement) => ({
          id: announcement.id,
          title: announcement.title,
          course: courseName(snapshot, announcement.courseId),
          posted: announcement.createdLocal ?? "unknown",
          pinned: announcement.pinned,
        })),
      },
      rows: shown.map((announcement) => announcementRow(snapshot, announcement)),
    };
  },
});
