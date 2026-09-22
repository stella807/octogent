import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze, classifyProvenance, parseTrailers } from "../src/provenance.mjs";

const commit = (over = {}) => ({
  sha: "a".repeat(40),
  author: "Dev",
  email: "dev@example.com",
  date: "2026-01-01T00:00:00Z",
  subject: "Add a thing",
  body: "",
  insertions: 10,
  deletions: 2,
  files: ["src/a.ts"],
  ...over,
});

describe("parseTrailers", () => {
  it("reads key/value trailers from the commit body", () => {
    const trailers = parseTrailers(
      "Some prose\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nSigned-off-by: Dev <dev@x.io>",
    );
    assert.deepEqual(trailers, [
      { key: "co-authored-by", value: "Claude <noreply@anthropic.com>" },
      { key: "signed-off-by", value: "Dev <dev@x.io>" },
    ]);
  });

  it("ignores a line whose key contains spaces", () => {
    assert.deepEqual(parseTrailers("Some note: this is prose, not a trailer key"), []);
  });

  it("ignores trailers when the final paragraph is prose", () => {
    assert.deepEqual(
      parseTrailers("Co-Authored-By: Claude <noreply@anthropic.com>\n\nOne more thought."),
      [],
    );
  });
});

describe("classifyProvenance", () => {
  it("marks a commit agent-authored when an agent co-author trailer is present", () => {
    const result = classifyProvenance(
      commit({ body: "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" }),
    );
    assert.equal(result.provenance, "agent");
    assert.equal(result.agent, "claude");
  });

  it("recognises other vendors' trailers", () => {
    assert.equal(
      classifyProvenance(commit({ body: "Co-authored-by: Cursor Agent <agent@cursor.com>" })).agent,
      "cursor",
    );
    assert.equal(
      classifyProvenance(commit({ body: "Co-authored-by: Copilot <copilot@github.com>" })).agent,
      "copilot",
    );
  });

  it("falls back to generated-with markers when no trailer is present", () => {
    const result = classifyProvenance(commit({ body: "Generated with Claude Code" }));
    assert.equal(result.provenance, "agent");
  });

  it("treats an ordinary human commit as human-authored", () => {
    const result = classifyProvenance(commit({ body: "Reviewed-by: Someone <s@x.io>" }));
    assert.equal(result.provenance, "human");
    assert.equal(result.agent, null);
  });

  it("does not misread a human co-author as an agent", () => {
    assert.equal(
      classifyProvenance(commit({ body: "Co-authored-by: Claudia Rivera <claudia@x.io>" }))
        .provenance,
      "human",
    );
  });
});

describe("analyze", () => {
  it("reports the load line as the agent share of changed lines", () => {
    const report = analyze([
      commit({
        sha: "1".repeat(40),
        insertions: 70,
        deletions: 0,
        body: "Co-authored-by: Claude <noreply@anthropic.com>",
      }),
      commit({ sha: "2".repeat(40), insertions: 30, deletions: 0 }),
    ]);
    assert.equal(report.loadLine.agentLineShare, 0.7);
    assert.equal(report.totals.commits, 2);
  });

  it("attributes a revert to the commit it reverts", () => {
    const target = "1".repeat(40);
    const report = analyze([
      commit({ sha: target, body: "Co-authored-by: Claude <noreply@anthropic.com>" }),
      commit({
        sha: "2".repeat(40),
        subject: `Revert "Add a thing"`,
        body: `This reverts commit ${target}.`,
        date: "2026-01-02T00:00:00Z",
      }),
    ]);
    assert.equal(report.cohorts.agent.reverted, 1);
    assert.equal(report.cohorts.agent.revertRate, 1);
  });

  it("counts a later fix touching the same file as rework", () => {
    const report = analyze(
      [
        commit({
          sha: "1".repeat(40),
          body: "Co-authored-by: Claude <noreply@anthropic.com>",
          files: ["src/pay.ts"],
        }),
        commit({
          sha: "2".repeat(40),
          subject: "Fix crash in payments",
          date: "2026-01-03T00:00:00Z",
          files: ["src/pay.ts"],
        }),
      ],
      { reworkWindowDays: 14 },
    );
    assert.equal(report.cohorts.agent.reworked, 1);
  });

  it("does not count rework outside the window", () => {
    const report = analyze(
      [
        commit({
          sha: "1".repeat(40),
          body: "Co-authored-by: Claude <noreply@anthropic.com>",
          files: ["src/pay.ts"],
        }),
        commit({
          sha: "2".repeat(40),
          subject: "Fix crash in payments",
          date: "2026-06-01T00:00:00Z",
          files: ["src/pay.ts"],
        }),
      ],
      { reworkWindowDays: 14 },
    );
    assert.equal(report.cohorts.agent.reworked, 0);
  });

  it("expresses risk as the agent-to-human failure ratio", () => {
    const report = analyze([
      commit({ sha: "1".repeat(40), body: "Co-authored-by: Claude <a@b.c>", files: ["src/a.ts"] }),
      commit({ sha: "2".repeat(40), body: "Co-authored-by: Claude <a@b.c>", files: ["src/b.ts"] }),
      commit({ sha: "3".repeat(40), files: ["src/c.ts"] }),
      commit({ sha: "4".repeat(40), files: ["src/d.ts"] }),
      commit({
        sha: "5".repeat(40),
        subject: "Fix a",
        date: "2026-01-02T00:00:00Z",
        files: ["src/a.ts"],
      }),
      commit({
        sha: "6".repeat(40),
        subject: "Fix b",
        date: "2026-01-02T00:00:00Z",
        files: ["src/b.ts"],
      }),
      commit({
        sha: "7".repeat(40),
        subject: "Fix c",
        date: "2026-01-02T00:00:00Z",
        files: ["src/c.ts"],
      }),
    ]);
    // Fix commits are remediation, not new risk, so they are not scored as subjects themselves.
    // Agent subjects: 2, both reworked. Human subjects: 2, one reworked. 1.0 / 0.5 = 2.
    assert.equal(report.cohorts.agent.failureRate, 1);
    assert.equal(report.cohorts.human.failureRate, 0.5);
    assert.equal(report.risk.ratio, 2);
  });

  it("reports an unknown ratio rather than dividing by zero", () => {
    const report = analyze([commit({ body: "Co-authored-by: Claude <a@b.c>" })]);
    assert.equal(report.risk.ratio, null);
  });

  it("does not link commits through high-traffic files", () => {
    // A lockfile touched by every commit says nothing about whether a change failed.
    const history = [
      commit({
        sha: "1".repeat(40),
        body: "Co-authored-by: Claude <a@b.c>",
        files: ["pnpm-lock.yaml"],
      }),
      commit({
        sha: "2".repeat(40),
        subject: "Fix the build",
        date: "2026-01-02T00:00:00Z",
        files: ["pnpm-lock.yaml"],
      }),
    ];
    assert.equal(analyze(history).cohorts.agent.reworked, 0);
  });

  it("ignores a file touched by most commits even when it is not a known lockfile", () => {
    const history = Array.from({ length: 10 }, (_, index) =>
      commit({
        sha: String(index).repeat(40),
        date: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        subject: index % 2 === 0 ? "Add a thing" : "Fix a thing",
        files: ["src/registry.ts"],
      }),
    );
    assert.equal(analyze(history).cohorts.human.reworked, 0);
  });

  it("does not attribute rework to a sweeping fix commit", () => {
    // "fix lint" across the whole tree is maintenance, not a remediation of any one change.
    const sweep = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`);
    const history = [
      commit({
        sha: "1".repeat(40),
        body: "Co-authored-by: Claude <a@b.c>",
        files: ["src/file-3.ts"],
      }),
      commit({
        sha: "2".repeat(40),
        subject: "fix lint",
        date: "2026-01-02T00:00:00Z",
        files: sweep,
      }),
    ];
    assert.equal(analyze(history).cohorts.agent.reworked, 0);
  });

  it("handles an empty history without throwing", () => {
    const report = analyze([]);
    assert.equal(report.totals.commits, 0);
    assert.equal(report.loadLine.agentLineShare, 0);
    assert.equal(report.risk.ratio, null);
  });
});
