import { BrightspaceClient, DEMO_LE_VERSION, FixtureTransport, MATERIAL_LIMITS, buildDemoTenant, contentTocSchema, demoFileFetch, demoResolver, fetchFile, isApprovedFilePath, jsonResponse, pageLinks, routes, toMaterials, validateApprovedPath } from "@nova-agent/brightspace";
import { describe, expect, it } from "vitest";
import { NOW, TENANT } from "../helpers/demoDashboard";

const LE = DEMO_LE_VERSION;
const TOC = routes.contentToc(LE, "31001");
const TOPIC = routes.contentTopicFile(LE, "31001", "8101");

const topic = (id: number | string, title: string, extra: Record<string, unknown> = {}) => ({ TopicId: id, Title: title, TypeIdentifier: "File", Url: `/content/enforced/1/${String(id)}.pdf`, IsHidden: false, LastModifiedDate: "2026-08-25T14:00:00.000Z", ...extra });
const moduleOf = (id: number, title: string, topics: unknown[], modules: unknown[] = [], extra: Record<string, unknown> = {}) => ({ ModuleId: id, Title: title, Topics: topics, Modules: modules, IsHidden: false, ...extra });

describe("content routes", () => {
  it("allow the table of contents and one topic's file, by ids, and nothing near them", () => {
    expect(TOC).toBe("/d2l/api/le/1.79/31001/content/toc");
    expect(TOPIC).toBe("/d2l/api/le/1.79/31001/content/topics/8101/file");
    expect(validateApprovedPath(TOC)?.operation).toBe("contentToc");
    expect(validateApprovedPath(TOPIC)?.operation).toBe("contentTopicFile");
    // The topic's file is a download; the table of contents is JSON and is not served through the file bridge.
    expect(isApprovedFilePath(TOPIC, TENANT)).toBe(true);
    expect(isApprovedFilePath(TOC, TENANT)).toBe(false);
    for (const bad of [
      "/d2l/api/le/1.79/31001/content/toc?ignoreDateRestrictions=true",
      "/d2l/api/le/1.79/31001/content/toc/",
      "/d2l/api/le/1.79/31001/content/root/",
      "/d2l/api/le/1.79/31001/content/modules/7101/structure/",
      "/d2l/api/le/1.79/31001/content/topics/8101",
      "/d2l/api/le/1.79/31001/content/topics/8101/file?stream=true",
      "/d2l/api/le/1.79/31001/content/topics/8101/file/extra",
      "/d2l/api/le/1.79/31001/content/topics/../8101/file",
      "/d2l/api/le/1.79/31001/content/topics/abc/file",
      "/content/enforced/31001-ECE2042/syllabus.html",
      "https://evil.example/d2l/api/le/1.79/31001/content/topics/8101/file",
    ]) {
      expect(validateApprovedPath(bad, TENANT), bad).toBeNull();
      expect(isApprovedFilePath(bad, TENANT), bad).toBe(false);
    }
    expect(() => routes.contentToc(LE, "31001/..")).toThrow();
    expect(() => routes.contentTopicFile(LE, "31001", "8101?x=1")).toThrow();
    expect(() => routes.contentTopicFile("1.79/../..", "31001", "8101")).toThrow();
    expect(pageLinks.contentTopic(TENANT, "31001", "8101")).toBe(`${TENANT}/d2l/le/content/31001/viewContent/8101/View`);
    expect(() => pageLinks.contentTopic(TENANT, "31001", "x")).toThrow();
  });
});

describe("the table of contents", () => {
  it("parses nested modules, and drops one malformed topic or module without losing its siblings", () => {
    const parsed = contentTocSchema.parse({
      Modules: [
        moduleOf(1, "Week 1", [topic(11, "Slides"), { Title: "no id" }, "junk", topic(12, "Reading")], [moduleOf(2, "Extras", [topic(21, "Notes")]), { Title: "module with no id" }]),
        null,
        moduleOf(3, "Empty", null as unknown as unknown[], undefined),
      ],
    });
    expect(parsed.Modules.map((entry) => entry.Title)).toEqual(["Week 1", "Empty"]);
    expect(parsed.Modules[0]?.Topics.map((entry) => entry.TopicId)).toEqual(["11", "12"]);
    expect(parsed.Modules[0]?.Modules.map((entry) => entry.Title)).toEqual(["Extras"]);
    expect(parsed.Modules[1]).toMatchObject({ Topics: [], Modules: [] });
    expect(contentTocSchema.parse({ Modules: null }).Modules).toEqual([]);
    expect(contentTocSchema.parse({}).Modules).toEqual([]);
  });

  it("flattens into topics in course order, with module path, kind, file name, and the topic's own page", () => {
    const tenant = buildDemoTenant(NOW);
    const materials = toMaterials(contentTocSchema.parse(tenant.courseData["31001"]?.toc), "31001", TENANT);
    expect(materials).toEqual([
      { id: "8101", courseId: "31001", title: "Syllabus", modulePath: ["Course information"], type: "page", fileName: "syllabus.html", url: `${TENANT}/d2l/le/content/31001/viewContent/8101/View`, updatedAt: "2026-08-25T14:00:00.000Z" },
      { id: "8102", courseId: "31001", title: "Lecture 5: Interrupts", modulePath: ["Week 3: Interrupts"], type: "file", fileName: "lecture5-interrupts.pptx", url: `${TENANT}/d2l/le/content/31001/viewContent/8102/View`, updatedAt: "2026-08-25T14:00:00.000Z" },
      { id: "8103", courseId: "31001", title: "Background reading on latency", modulePath: ["Week 3: Interrupts"], type: "link", fileName: null, url: `${TENANT}/d2l/le/content/31001/viewContent/8103/View`, updatedAt: "2026-08-25T14:00:00.000Z" },
      { id: "8104", courseId: "31001", title: "Lab manual", modulePath: ["Week 3: Interrupts", "Lab materials"], type: "file", fileName: "lab-manual.pdf", url: `${TENANT}/d2l/le/content/31001/viewContent/8104/View`, updatedAt: "2026-08-25T14:00:00.000Z" },
    ]);
    // The address Brightspace gave for a link is never kept: only the topic's own page on the tenant is.
    expect(JSON.stringify(materials)).not.toContain("example.invalid");
    expect(JSON.stringify(materials)).not.toContain("/content/enforced");
  });

  it("leaves out hidden modules and topics, untitled topics, and anything that is not a quiz-free file name", () => {
    const toc = contentTocSchema.parse({
      Modules: [
        moduleOf(1, "  ", [topic(11, "Visible", { Url: "/content/enforced/1/Week%201%20notes.PDF?ou=1#page=2" }), topic(12, "Hidden", { IsHidden: true }), topic(13, "   "), topic(14, "A quiz", { TypeIdentifier: "Quiz", Url: "/d2l/lms/quizzing/quizzing.d2l?qi=5" }), topic(15, "No extension", { Url: "/content/enforced/1/README" }), topic(16, "Bad escape", { Url: "/content/enforced/1/100%.docx" })]),
        moduleOf(2, "Hidden module", [topic(21, "Inside hidden")], [moduleOf(3, "Child of hidden", [topic(31, "Deep inside hidden")])], { IsHidden: true }),
      ],
    });
    const materials = toMaterials(toc, "1", `${TENANT}/`);
    expect(materials.map((entry) => [entry.id, entry.type, entry.fileName])).toEqual([
      ["11", "file", "Week 1 notes.PDF"],
      ["14", "other", null],
      ["15", "file", null],
      ["16", "file", "100%.docx"],
    ]);
    expect(materials[0]?.modulePath).toEqual(["Untitled module"]);
    expect(materials[0]?.url).toBe(`${TENANT}/d2l/le/content/1/viewContent/11/View`);
  });

  it("stops at the topic and depth limits", () => {
    const many = contentTocSchema.parse({ Modules: [moduleOf(1, "Big", Array.from({ length: MATERIAL_LIMITS.topics + 25 }, (_, index) => topic(1000 + index, `Topic ${index}`)))] });
    expect(toMaterials(many, "1", TENANT)).toHaveLength(MATERIAL_LIMITS.topics);
    let nested: unknown = moduleOf(99, "Deepest", [topic(999, "Too deep")]);
    for (let depth = MATERIAL_LIMITS.depth; depth >= 1; depth--) nested = moduleOf(depth, `Level ${depth}`, [topic(100 + depth, `At ${depth}`)], [nested]);
    const deep = toMaterials(contentTocSchema.parse({ Modules: [nested] }), "1", TENANT);
    expect(deep.map((entry) => entry.title)).toEqual(Array.from({ length: MATERIAL_LIMITS.depth }, (_, index) => `At ${index + 1}`));
    expect(deep.at(-1)?.modulePath).toHaveLength(MATERIAL_LIMITS.depth);
  });
});

describe("BrightspaceClient.listMaterials", () => {
  const client = (overrides: Record<string, unknown> = {}) => {
    const transport = new FixtureTransport(demoResolver(buildDemoTenant(NOW), overrides));
    return { transport, client: new BrightspaceClient(transport, { tenantOrigin: TENANT, now: () => NOW }) };
  };

  it("makes one approved request for one course and returns its topics", async () => {
    const { client: brightspace, transport } = client();
    const materials = await brightspace.listMaterials("31001");
    expect(materials.map((entry) => entry.title)).toEqual(["Syllabus", "Lecture 5: Interrupts", "Background reading on latency", "Lab manual"]);
    expect(transport.requests.filter((path) => path.includes("/content/"))).toEqual([TOC]);
    expect((await brightspace.listMaterials("31003")).map((entry) => entry.fileName)).toEqual(["fourier-notes.txt"]);
    // A course with an empty Content area is an empty list, not a failure.
    expect(await brightspace.listMaterials("31002")).toEqual([]);
  });

  it("reports a refusal as a typed failure and never guesses a list", async () => {
    const { client: brightspace } = client({ [TOC]: jsonResponse({ Errors: [{ Message: "Forbidden" }] }, 403) });
    await expect(brightspace.listMaterials("31001")).rejects.toMatchObject({ error: { kind: "permission-denied" } });
    await expect(brightspace.listMaterials("31001; drop")).rejects.toThrow();
  });
});

describe("demo topic files", () => {
  it("are served through the file bridge for the topics that are files, and nothing else", async () => {
    const fetch = demoFileFetch(buildDemoTenant(NOW));
    const syllabus = await fetchFile(fetch, TOPIC, { tenantOrigin: TENANT });
    expect(syllabus.contentType).toContain("text/html");
    expect(new TextDecoder().decode(syllabus.bytes)).toContain("Late work loses 10 percent per day");
    expect((await fetchFile(fetch, routes.contentTopicFile(LE, "31001", "8102"), { tenantOrigin: TENANT })).bytes.length).toBeGreaterThan(200);
    // A link topic has no file behind it.
    await expect(fetchFile(fetch, routes.contentTopicFile(LE, "31001", "8103"), { tenantOrigin: TENANT })).rejects.toMatchObject({ reason: "not-found" });
    await expect(fetchFile(fetch, TOC as never, { tenantOrigin: TENANT })).rejects.toMatchObject({ reason: "unsafe-path" });
  });
});
