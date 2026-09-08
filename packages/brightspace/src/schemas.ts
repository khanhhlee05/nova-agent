import { z } from "zod";

/**
 * Zod schemas for the D2L payloads Nova Agent consumes. Objects strip unknown
 * properties (D2L adds fields over time) and every field a learner may not see
 * is nullable or optional.
 */

/** Minimal structural schema contract so core never depends on Zod. */
export type Schema<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
};

const id = z.union([z.number(), z.string()]).transform((value) => String(value));
const isoDate = z.string().nullable().optional().transform((value) => value ?? null);
const richText = z
  .object({ Text: z.string().nullable().optional(), Html: z.string().nullable().optional() })
  .nullable()
  .optional();

export const productVersionSchema = z.object({
  ProductCode: z.string(),
  LatestVersion: z.string().nullable().optional(),
  SupportedVersions: z.array(z.string()).optional().default([]),
});
export const versionsSchema = z.array(productVersionSchema);
export type ProductVersion = z.infer<typeof productVersionSchema>;

export const whoAmISchema = z.object({
  Identifier: id,
  FirstName: z.string().nullable().optional(),
  LastName: z.string().nullable().optional(),
  UniqueName: z.string().nullable().optional(),
});
export type WhoAmI = z.infer<typeof whoAmISchema>;

export const pagingInfoSchema = z.object({ Bookmark: z.string().nullable().optional(), HasMoreItems: z.boolean() });

export const myOrgUnitInfoSchema = z.object({
  OrgUnit: z.object({
    Id: id,
    Name: z.string(),
    Code: z.string().nullable().optional(),
    Type: z.object({ Id: z.number().optional(), Code: z.string().nullable().optional(), Name: z.string().nullable().optional() }).optional(),
  }),
  Access: z
    .object({
      IsActive: z.boolean().optional(),
      CanAccess: z.boolean().optional(),
      StartDate: isoDate,
      EndDate: isoDate,
    })
    .optional(),
});
export type MyOrgUnitInfo = z.infer<typeof myOrgUnitInfoSchema>;

export const enrollmentsPageSchema = z.object({ PagingInfo: pagingInfoSchema, Items: z.array(myOrgUnitInfoSchema) });
export type EnrollmentsPage = z.infer<typeof enrollmentsPageSchema>;

export const dropboxFolderSchema = z.object({
  Id: id,
  Name: z.string(),
  DueDate: isoDate,
  IsHidden: z.boolean().optional(),
  Availability: z.object({ StartDate: isoDate, EndDate: isoDate }).nullable().optional(),
  Assessment: z.object({ ScoreDenominator: z.number().nullable().optional() }).nullable().optional(),
  DropboxType: z.number().optional(),
  GroupTypeId: z.number().nullable().optional(),
  CustomInstructions: richText,
});
export type DropboxFolder = z.infer<typeof dropboxFolderSchema>;
export const dropboxFoldersSchema = z.array(dropboxFolderSchema);

/** D2L DROPBOX_STATUS: 0 Unsubmitted, 1 Submitted, 2 Draft, 3 Published. */
export const entityDropboxSchema = z.object({
  Entity: z.object({ EntityId: id.optional(), EntityType: z.string().optional() }).optional(),
  Status: z.number().optional(),
  CompletionDate: isoDate,
  Submissions: z.array(z.object({ Id: id.optional(), SubmissionDate: isoDate })).optional().default([]),
});
export type EntityDropbox = z.infer<typeof entityDropboxSchema>;
export const mySubmissionsSchema = z.array(entityDropboxSchema);

export const quizReadDataSchema = z.object({
  QuizId: id,
  Name: z.string(),
  IsActive: z.boolean().optional(),
  StartDate: isoDate,
  EndDate: isoDate,
  DueDate: isoDate,
  GradeItemId: z.number().nullable().optional(),
});
export type QuizReadData = z.infer<typeof quizReadDataSchema>;
export const quizzesPageSchema = z.object({ Objects: z.array(quizReadDataSchema), Next: z.string().nullable().optional() });
export type QuizzesPage = z.infer<typeof quizzesPageSchema>;

export const newsItemSchema = z.object({
  Id: id,
  Title: z.string(),
  Body: richText,
  IsHidden: z.boolean().optional(),
  IsPublished: z.boolean().optional(),
  IsPinned: z.boolean().optional(),
  StartDate: isoDate,
  EndDate: isoDate,
  CreatedDate: isoDate,
  LastModifiedDate: isoDate,
});
export type NewsItem = z.infer<typeof newsItemSchema>;
export const newsListSchema = z.array(newsItemSchema);
